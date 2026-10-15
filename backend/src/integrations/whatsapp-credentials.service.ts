import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
import { CredentialCrypto } from '../integration/framework/credential-crypto';

/**
 * Per-tenant WhatsApp credentials (Phase A5 → A14).
 *
 * ## What this replaces, and why it mattered
 *
 * Sending previously read `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID`
 * straight from the process environment. With one tenant that works. With two it
 * is a serious fault: every organisation would send from — and appear to their
 * customers as — the same business, using a token none of them own.
 *
 * ## The resolution order, and why there is no guessing in it
 *
 *   1. The organisation's own `Integration` (provider `whatsapp_cloud`) with an
 *      encrypted `access_token` and a `phone_number` asset. Tenant-owned,
 *      rotatable, revocable, and the target state.
 *
 *   2. A platform-owned number, used ONLY by the organisation named in
 *      `WHATSAPP_PLATFORM_ORGANISATION_ID`.
 *
 * Step 2 needs justifying, because "fall back to env" is exactly the pattern the
 * architecture forbids. The forbidden version is an IMPLICIT fallback — first
 * organisation, only organisation, default account — where a second tenant
 * silently inherits someone else's identity. This is not that: it sends only to
 * the single organisation an operator has explicitly named, every other tenant
 * gets nothing, and the resolver reports `scope: 'platform_env'` so the UI can
 * say out loud that the number is not the tenant's own. With the variable unset,
 * there is no fallback at all.
 *
 * That keeps the existing Eclat deployment working while making the shared
 * credential visible as the transitional arrangement it is, rather than a
 * silent default that nobody notices until the second customer signs up.
 *
 * ## OAuth
 *
 * Meta's onboarding flow has NOT been verified against live provider
 * documentation, so no OAuth exchange is implemented here. What is implemented
 * is the shape it needs: credentials already live encrypted per integration with
 * `kind`, `expiresAt` and `rotatedAt`, so an OAuth token and its refresh
 * counterpart drop into the existing rows with no schema change.
 */

export type CredentialScope = 'tenant' | 'platform_env' | 'none';

/**
 * WHY no number could be used, for the callers that treat the kinds
 * differently. The sentence in `reason` is what a person reads; this is what
 * code may branch on, so nobody has to match on prose.
 *
 *   sender_ambiguous — several numbers could carry it and nothing said which.
 *   sender_audience  — the only numbers available are for the other audience
 *                      (a customer message with nothing but staff lines).
 *   no_number        — a connection exists with no number registered on it.
 *   credential       — a number was chosen, its account's token is missing,
 *                      expired or unreadable.
 *   not_connected    — this organisation has no WhatsApp at all.
 *
 * The first two are DECISIONS the product refuses to make for a business, and a
 * caller should say so before it claims to have sent anything. The rest are
 * states of a half-finished or broken setup, which the outbox reports against
 * the message and a retry can fix without the sender doing anything again.
 */
export type SenderProblem =
  | 'sender_ambiguous'
  | 'sender_audience'
  | 'no_number'
  | 'credential'
  | 'not_connected';

export interface WhatsAppSender {
  /** Whether a message can actually be delivered for this organisation. */
  usable: boolean;
  scope: CredentialScope;
  accessToken: string | null;
  phoneNumberId: string | null;
  /** The tenant's Integration row, when the credential came from one. */
  integrationId: string | null;
  /** Present when `usable` is false — always a sentence a UI can show. */
  reason: string | null;
  /** The machine-readable half of `reason`. Null when usable. */
  code: SenderProblem | null;
  /** True when this organisation is borrowing the platform's number. */
  shared: boolean;
  /**
   * WHICH of the tenant's numbers this is, and how it was chosen.
   *
   * Recorded because "the message went out" is not the useful fact once a
   * tenant has eight numbers across two accounts — "it went out from the Surat
   * number because that thread arrived there" is. `assetId` is stored on the
   * conversation so every later reply leaves from the same number.
   */
  assetId: string | null;
  /** 'thread' | 'store_route' | 'only_number' | 'platform_env' | null. */
  resolvedBy: SenderResolution | null;
  /** The branch whose route was used, when one was. */
  storeId: string | null;
}

/**
 * How a sender was chosen. Ordered by authority, and the order is the design:
 *
 *   thread       — the number this conversation arrived on. A reply MUST leave
 *                  from it, or the customer gets a second thread from what
 *                  reads as a different business.
 *   store_route  — the branch's configured sender, for a NEW conversation.
 *   only_number  — the tenant has exactly one, so there is nothing to choose.
 *   platform_env — the explicitly bound platform number.
 */
export type SenderResolution = 'thread' | 'store_route' | 'only_number' | 'platform_env';

/**
 * WHO a message is for, which decides which KIND of number may carry it.
 *
 * `IntegrationAsset.purpose` records what each line is for ('internal' for a
 * staff operations line, NULL for customer-facing). This is the send-time half
 * of that: a quotation, a reminder or any other message to a customer must
 * never leave from the staff line, and not because of a setting somebody
 * remembered to tick — a customer who receives the business's internal number
 * replies to it, lands in the DSR bot, and is answered by nobody.
 *
 * Omitted means "no constraint", which is what every existing caller gets: the
 * numbers nobody has classified are customer-facing, so a tenant that never
 * used the field keeps the behaviour it has today.
 */
export type SenderAudience = 'customer' | 'internal';

/** Where a send is going, so the right number can be chosen for it. */
export interface SenderRoute {
  /** The asset a conversation already belongs to. Highest authority. */
  assetId?: string | null;
  /** The branch the message is on behalf of. */
  storeId?: string | null;
  /** Who it is for. A customer message is refused rather than sent from a staff line. */
  audience?: SenderAudience;
}

/**
 * The outcome of choosing a number, before any credential is read.
 *
 * `asset: null` means this tenant has none of its own, which is the ONLY case
 * that may fall through to the platform binding. Distinguished from a refusal
 * on purpose: a tenant with several numbers and no route must never silently
 * borrow the platform's.
 */
interface ChosenSender {
  asset: { id: string; externalId: string; integrationId: string } | null;
  resolvedBy: SenderResolution | null;
  storeId: string | null;
}

export const WHATSAPP_PROVIDER_CODE = 'whatsapp_cloud';

@Injectable()
export class WhatsAppCredentialsService {
  private readonly log = new Logger(WhatsAppCredentialsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly crypto: CredentialCrypto,
  ) {}

  /** The organisation an operator has bound the platform number to, if any. */
  private get platformOrganisationId(): string | null {
    return this.config.get<string>('WHATSAPP_PLATFORM_ORGANISATION_ID') || null;
  }

  /**
   * Resolve the sender for one organisation.
   *
   * Never throws and never returns a half-usable result: either there is a token
   * and a phone number id, or `usable` is false with a reason. A caller that had
   * to assemble those two from separate optional fields would eventually send
   * with one and not the other.
   */
  async senderFor(organisationId: string, route: SenderRoute = {}): Promise<WhatsAppSender> {
    // ---------------------------------------------------------- 1. tenant
    //
    // WHICH NUMBER, resolved before any credential is touched. The old code
    // took the first active asset of the first integration, which with eight
    // numbers across two accounts meant every branch sent from whichever was
    // registered first.
    const chosen = await this.chooseAsset(organisationId, route);
    if ('reason' in chosen) {
      return this.unusable('tenant', chosen.reason, chosen.integrationId ?? null, chosen.code);
    }
    if (chosen.asset) {
      return this.withToken(organisationId, { ...chosen, asset: chosen.asset });
    }

    // -------------------------------------------------- 2. platform number
    const boundOrg = this.platformOrganisationId;
    const envToken = this.config.get<string>('WHATSAPP_ACCESS_TOKEN') ?? '';
    const envPhone = this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID') ?? '';

    if (boundOrg && boundOrg === organisationId && envToken && envPhone) {
      return {
        usable: true,
        scope: 'platform_env',
        accessToken: envToken,
        phoneNumberId: envPhone,
        integrationId: null,
        reason: null,
        code: null,
        // Surfaced so the UI can state plainly that this number belongs to the
        // platform, not to the tenant.
        shared: true,
        // No asset row exists for the platform number, so there is nothing for a
        // conversation to pin itself to. Correct: the binding is per-deployment.
        assetId: null,
        resolvedBy: 'platform_env',
        storeId: null,
      };
    }

    // -------------------------------------------------------- 3. nothing
    if (envToken && envPhone && !boundOrg) {
      // The operator has a number configured but has not said who owns it. Doing
      // nothing is correct: picking an organisation here would be the implicit
      // default this whole service exists to remove.
      this.log.warn(
        'WHATSAPP_ACCESS_TOKEN is set but WHATSAPP_PLATFORM_ORGANISATION_ID is not. ' +
          'No organisation will use the platform number until one is named explicitly.',
      );
    }

    return this.unusable(
      'none',
      'No WhatsApp number is connected for this organisation. Connect one under Settings \u2192 Integrations.',
      null,
      'not_connected',
    );
  }

  /**
   * Which of the tenant's numbers should carry this message.
   *
   * Returns `{ asset: null }` to mean "this tenant has no number of its own" --
   * the only case that may fall through to the platform binding. A `reason`
   * means the tenant HAS numbers and none of them could be chosen, which must
   * never fall through: sending from an arbitrary one of eight is the bug this
   * whole block exists to remove.
   *
   * ## The order, and why each step is above the next
   *
   *   1. THE THREAD'S OWN NUMBER. A customer who wrote to the Surat line must be
   *      answered from the Surat line. Replying from another number opens a
   *      second thread on their phone, abandons the 24-hour customer-care window
   *      the first one earned, and reads as a different business.
   *
   *   2. THE BRANCH'S ROUTE. For a NEW conversation there is no thread to
   *      honour, so the branch acting decides.
   *
   *   3. THE ONLY NUMBER. With exactly one there is nothing to choose, which is
   *      why every single-number tenant keeps working with no configuration.
   *
   *   4. REFUSE. With several numbers and no route, the honest answer is to not
   *      send and to say which branch needs mapping. The previous behaviour --
   *      picking the oldest -- sent as the wrong branch and said nothing.
   *
   * ## The audience cuts across all four
   *
   * `route.audience` removes the numbers that may not carry this message AT
   * EVERY step, including a pinned thread and a configured branch route. It is
   * not a tie-breaker of last resort: a staff line that a customer's thread
   * happens to be pinned to is still a staff line, and a branch mapped to one
   * is a misconfiguration rather than an instruction. With the wrong kind of
   * number excluded, a two-line tenant (one shopfront, one operations) resolves
   * a customer send unambiguously with no branch route at all -- which is the
   * common shape and used to refuse as "2 numbers connected, none mapped".
   */
  private async chooseAsset(
    organisationId: string,
    route: SenderRoute,
  ): Promise<
    ChosenSender | { reason: string; code: SenderProblem; integrationId?: string | null }
  > {
    /** Set when a number WAS named for this message but is for the other audience. */
    let wrongAudience: 'thread' | 'store_route' | null = null;

    // -- 1. the thread's own number ----------------------------------------
    if (route.assetId) {
      const pinned = await this.prisma.integrationAsset.findFirst({
        where: {
          id: route.assetId,
          organisationId,
          kind: 'phone_number',
          isActive: true,
          integration: {
            providerCode: WHATSAPP_PROVIDER_CODE,
            status: { notIn: ['disabled'] },
          },
        },
        select: { id: true, externalId: true, integrationId: true, purpose: true },
      });
      if (pinned && carries(pinned.purpose, route.audience)) {
        return { asset: pinned, resolvedBy: 'thread', storeId: route.storeId ?? null };
      }
      if (pinned) wrongAudience = 'thread';
      // The number this thread arrived on has since been retired, its account
      // disabled, or it is the wrong kind of line for this message. Falling
      // through is the lesser harm: the alternative is never answering the
      // customer at all. `resolvedBy` reports whatever was used instead, so the
      // substitution is visible rather than silent.
    }

    // -- 2. the branch's route ---------------------------------------------
    if (route.storeId) {
      const configured = await this.prisma.storeMessagingRoute.findUnique({
        where: { storeId_channel: { storeId: route.storeId, channel: 'whatsapp' } },
        select: {
          organisationId: true,
          asset: {
            select: {
              id: true,
              externalId: true,
              integrationId: true,
              isActive: true,
              organisationId: true,
              purpose: true,
              integration: { select: { providerCode: true, status: true } },
            },
          },
        },
      });
      const asset = configured?.asset;
      // Every one of these has to agree. A route whose tenant does not match its
      // asset is corruption, not a choice to make quietly: the foreign keys
      // prevent new ones, and this stays as the fail-closed guard for any
      // historical or hand-edited row.
      if (
        configured &&
        asset &&
        configured.organisationId === organisationId &&
        asset.organisationId === organisationId &&
        asset.isActive &&
        asset.integration.providerCode === WHATSAPP_PROVIDER_CODE &&
        asset.integration.status !== 'disabled'
      ) {
        if (carries(asset.purpose, route.audience)) {
          return {
            asset: {
              id: asset.id,
              externalId: asset.externalId,
              integrationId: asset.integrationId,
            },
            resolvedBy: 'store_route',
            storeId: route.storeId,
          };
        }
        /*
         * The branch IS mapped -- to a line this message may not use.
         *
         * The mapping table is also the inbound half of routing (a staff
         * message to the operations line has to land in the right branch), so a
         * route naming the internal number is legitimate and must not be
         * deleted or refused when it is set. It simply cannot be the answer to
         * "which number does this customer hear from", and saying that out loud
         * is the difference between an operator fixing a mapping and an operator
         * hunting a connection that was never broken.
         */
        wrongAudience = 'store_route';
      }
    }

    // -- 3. the only number, or 4. refuse ----------------------------------
    const active = await this.prisma.integrationAsset.findMany({
      where: {
        organisationId,
        kind: 'phone_number',
        isActive: true,
        integration: {
          providerCode: WHATSAPP_PROVIDER_CODE,
          status: { notIn: ['disabled'] },
        },
      },
      select: { id: true, externalId: true, integrationId: true, purpose: true },
      orderBy: { createdAt: 'asc' },
    });
    // Only the numbers that may carry THIS message are candidates. Without the
    // audience this is every active number, so nothing changes for the callers
    // that do not name one.
    const candidates = active.filter((asset) => carries(asset.purpose, route.audience));

    if (candidates.length === 1) {
      return { asset: candidates[0], resolvedBy: 'only_number', storeId: route.storeId ?? null };
    }
    if (candidates.length === 0 && active.length > 0) {
      // Numbers exist, and every one of them is for the other audience. This is
      // a classification problem, not a connection problem, and the two have
      // completely different fixes.
      return {
        code: 'sender_audience',
        reason:
          route.audience === 'internal'
            ? `None of this organisation's ${active.length} WhatsApp numbers is marked as an ` +
              'internal staff line, so a staff notice has nothing to leave from. Mark the ' +
              'operations number as internal under Settings → Integrations.'
            : `All ${active.length} WhatsApp numbers connected to this organisation are marked ` +
              'as internal staff lines, and a customer must never be messaged from one. Mark ' +
              'the shopfront number as customer-facing under Settings → Integrations.',
      };
    }
    if (active.length === 0) {
      // Does the tenant have a connection at all? The distinction matters: one
      // is "finish setting this up", the other is "you have no WhatsApp".
      const integration = await this.prisma.integration.findFirst({
        where: {
          organisationId,
          providerCode: WHATSAPP_PROVIDER_CODE,
          status: { notIn: ['disabled'] },
        },
        select: { id: true },
      });
      if (integration) {
        return {
          code: 'no_number',
          reason:
            'A WhatsApp integration exists but no phone number has been registered against it.',
          integrationId: integration.id,
        };
      }
      // No numbers AND no connection: the platform binding may still apply.
      return { asset: null, resolvedBy: null, storeId: null };
    }

    // Several numbers and nothing said which. The count goes in the sentence
    // because "no sender configured" reads like a missing connection, and the
    // actual state is the opposite -- there are too many to guess between.
    const kind = route.audience === 'customer' ? 'customer-facing WhatsApp numbers' : 'WhatsApp numbers';
    return {
      code: 'sender_ambiguous',
      reason:
        `This organisation has ${candidates.length} ${kind} connected and ` +
        `${
          wrongAudience === 'store_route'
            ? 'this branch is mapped to a number marked as an internal staff line'
            : wrongAudience === 'thread'
              ? 'the thread it belongs to is held on a number marked as an internal staff line'
              : route.storeId
                ? 'this branch has no sender mapped to it'
                : 'no branch was named for this message'
        }. ` +
        'Map each branch to the number it sends from under Settings \u2192 Integrations. ' +
        'Nothing is sent until then, because sending from the wrong number reaches the ' +
        'customer as a different business.',
    };
  }

  /**
   * Decrypt the token belonging to the chosen number's own account.
   *
   * Read from THAT asset's integration, not the tenant's first one. With two
   * WABA accounts the two tokens are different, and using one account's token
   * against the other's number is refused by the provider -- which would have
   * surfaced as an inexplicable send failure on exactly half the branches.
   */
  private async withToken(
    organisationId: string,
    chosen: ChosenSender & { asset: NonNullable<ChosenSender['asset']> },
  ): Promise<WhatsAppSender> {
    const integrationId = chosen.asset.integrationId;
    const credential = await this.prisma.integrationCredential.findUnique({
      where: { integrationId_kind: { integrationId, kind: 'access_token' } },
    });
    if (!credential || credential.organisationId !== organisationId) {
      return this.unusable(
        'tenant',
        'The account that owns this number has no access token saved for it.',
        integrationId,
        'credential',
      );
    }
    if (credential.expiresAt && credential.expiresAt.getTime() < Date.now()) {
      return this.unusable(
        'tenant',
        `The stored WhatsApp token expired on ${credential.expiresAt
          .toISOString()
          .slice(0, 10)}. Replace it to resume sending.`,
        integrationId,
        'credential',
      );
    }

    try {
      const encrypted = {
        ciphertext: credential.ciphertext,
        iv: credential.iv,
        authTag: credential.authTag,
        keyVersion: credential.keyVersion,
      };
      const context = { organisationId, integrationId, kind: 'access_token' };
      const accessToken = this.crypto.decrypt(encrypted, context);
      // Verify cryptographic ownership by ACTIVE, not only the version stamp.
      // This also heals a key rotation where VERSION was accidentally unchanged.
      const needsUpgrade = !this.crypto.isEncryptedWithActiveKey(encrypted, context);
      const upgraded = needsUpgrade ? this.crypto.encrypt(accessToken, context) : null;
      // Touched on use, so an unused credential can be spotted and revoked.
      // Fire-and-forget: failing to write a usage timestamp must not stop a
      // customer message going out.
      void this.prisma.integrationCredential
        .updateMany({
          where: { id: credential.id, ciphertext: credential.ciphertext },
          data: {
            lastUsedAt: new Date(),
            ...(upgraded
              ? {
                  ciphertext: upgraded.ciphertext,
                  iv: upgraded.iv,
                  authTag: upgraded.authTag,
                  keyVersion: upgraded.keyVersion,
                }
              : {}),
          },
        })
        .catch(() => undefined);

      return {
        usable: true,
        scope: 'tenant',
        accessToken,
        phoneNumberId: chosen.asset.externalId,
        integrationId,
        reason: null,
        code: null,
        shared: false,
        assetId: chosen.asset.id,
        resolvedBy: chosen.resolvedBy,
        storeId: chosen.storeId,
      };
    } catch (e) {
      // A credential that will not decrypt is a real, actionable state -- a
      // rotated master key, a corrupted row -- and saying so is far better than
      // quietly falling through to the platform number and sending as someone
      // else's business.
      return this.unusable(
        'tenant',
        `The stored WhatsApp token could not be decrypted (${
          e instanceof Error ? e.message : 'unknown error'
        }). It must be re-entered.`,
        integrationId,
        'credential',
      );
    }
  }

  /**
   * Which organisation does an inbound `phone_number_id` belong to?
   *
   * ASSET-BASED ONLY, and it returns null rather than guessing. An inbound
   * message that cannot be attributed to a tenant must stay unattributed:
   * routing a stranger's message into whichever organisation happens to be first
   * would put one business's customer conversation in another's inbox.
   *
   * The platform binding participates here too — but only the explicit one, and
   * only for the number the platform actually owns.
   */
  /**
   * The INTERNAL staff line's route, or undefined when none is configured.
   * The evening DSR digest established the pattern: staff-facing automation
   * leaves from the number staff already know, never from a customer line.
   * Shared here so every scheduled staff delivery picks the same sender.
   */
  async internalRoute(organisationId: string): Promise<{ assetId: string } | undefined> {
    const asset = await this.prisma.integrationAsset.findFirst({
      where: {
        organisationId,
        kind: 'phone_number',
        purpose: 'internal',
        isActive: true,
        integration: { providerCode: 'whatsapp_cloud', status: { notIn: ['disabled'] } },
      },
      select: { id: true },
    });
    return asset ? { assetId: asset.id } : undefined;
  }

  async organisationForPhoneNumberId(phoneNumberId: string): Promise<{
    organisationId: string;
    integrationId: string | null;
    scope: CredentialScope;
    /**
     * WHICH number it arrived on. Null for the platform sender, which has no
     * asset row. Stored on the conversation so every reply leaves from here.
     */
    assetId: string | null;
    /**
     * WHAT THE NUMBER IS FOR: 'internal' for a staff operations line, null for
     * a customer-facing one.
     *
     * Read before anything else decides what a message means. Two bots share
     * one webhook, and which of them answers has to be settled by the line that
     * was written to, not only by who wrote: an operations number that replies
     * to a stranger with a sales script is the failure this prevents.
     */
    purpose: string | null;
    /**
     * The branch that number is mapped to, when one is. This is the inbound
     * half of routing: a message to the Surat line opens a Surat thread, rather
     * than landing unattributed and being picked up by whoever looks first.
     */
    storeId: string | null;
  } | null> {
    if (!phoneNumberId) return null;

    // Fetch up to two because more than one owner is corruption, never a choice
    // to make with findFirst(). The database ownership key prevents new races;
    // this remains a fail-closed guard for historical/manual data.
    const assets = await this.prisma.integrationAsset.findMany({
      where: {
        kind: 'phone_number',
        externalId: phoneNumberId,
        isActive: true,
        integration: { providerCode: WHATSAPP_PROVIDER_CODE },
      },
      take: 2,
      select: {
        id: true,
        organisationId: true,
        integrationId: true,
        purpose: true,
        integration: { select: { organisationId: true } },
        // The branch this number answers for, so inbound lands in the right one.
        messagingRoutes: {
          where: { channel: 'whatsapp' },
          select: { storeId: true, organisationId: true },
          // A number may serve several branches (a head-office line answering
          // for three shops). Two is enough to know it is ambiguous, and an
          // ambiguous inbound branch is left null rather than guessed.
          take: 2,
        },
      },
    });
    const boundOrg = this.platformOrganisationId;
    const envPhone = this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID') ?? '';
    if (envPhone && envPhone === phoneNumberId) {
      if (assets.length > 0) {
        this.log.error(
          'WhatsApp inbound ownership is ambiguous: the platform sender is also registered as a tenant asset.',
        );
        return null;
      }
      return boundOrg
        ? {
            organisationId: boundOrg,
            integrationId: null,
            scope: 'platform_env',
            assetId: null,
            // The platform sender has no asset row to classify, and it is the
            // number customers were given. Null is the honest answer and the
            // safe one: it keeps the customer bot on the line it has always
            // been on.
            purpose: null,
            storeId: null,
          }
        : null;
    }

    if (assets.length !== 1) {
      if (assets.length > 1) {
        this.log.error(
          'WhatsApp inbound ownership is ambiguous: multiple active tenant assets use the same phone-number ID.',
        );
      }
      return null;
    }
    const asset = assets[0];
    const parentOrganisationId = asset.integration.organisationId;
    if (asset.organisationId !== parentOrganisationId) {
      this.log.error(
        'WhatsApp inbound ownership is corrupt: the asset tenant does not match its parent integration.',
      );
      return null;
    }
    const routes = asset.messagingRoutes.filter(
      (r) => r.organisationId === parentOrganisationId,
    );
    return {
      organisationId: parentOrganisationId,
      integrationId: asset.integrationId,
      scope: 'tenant',
      assetId: asset.id,
      purpose: asset.purpose,
      // Exactly one branch, or none. A number shared by three shops cannot say
      // which one an inbound message belongs to, and picking one would file a
      // customer's enquiry against a branch that never spoke to them.
      storeId: routes.length === 1 ? routes[0].storeId : null,
    };
  }

  /** Sender state for a settings screen, with no secret in the payload. */
  async describeFor(organisationId: string) {
    const sender = await this.senderFor(organisationId);
    // How many numbers there are is the single most useful fact on this screen
    // once there is more than one: it turns "not usable" from a mystery into
    // "you have eight and have not said which branch uses which".
    const numbers = await this.prisma.integrationAsset.count({
      where: {
        organisationId,
        kind: 'phone_number',
        isActive: true,
        integration: {
          providerCode: WHATSAPP_PROVIDER_CODE,
          status: { notIn: ['disabled'] },
        },
      },
    });
    const routed = await this.prisma.storeMessagingRoute.count({
      where: { organisationId, channel: 'whatsapp' },
    });
    return {
      usable: sender.usable,
      scope: sender.scope,
      shared: sender.shared,
      reason: sender.reason,
      integrationId: sender.integrationId,
      numbersConnected: numbers,
      branchesRouted: routed,
      /** How the default sender was chosen, when there is one. */
      resolvedBy: sender.resolvedBy,
      // The last four digits only — enough to confirm which number is connected,
      // useless to anyone who intercepts it.
      phoneNumberIdSuffix: sender.phoneNumberId ? `…${sender.phoneNumberId.slice(-4)}` : null,
      oauth: {
        implemented: false,
        note: 'Meta’s embedded signup flow has not been verified against live provider documentation, so tokens are entered by hand today. The stored credential format already supports an OAuth access/refresh pair.',
      },
    };
  }

  private unusable(
    scope: CredentialScope,
    reason: string,
    integrationId: string | null,
    code: SenderProblem,
  ): WhatsAppSender {
    return {
      usable: false,
      scope,
      accessToken: null,
      phoneNumberId: null,
      integrationId,
      reason,
      code,
      shared: false,
      assetId: null,
      resolvedBy: null,
      storeId: null,
    };
  }
}

/**
 * May a number with this `purpose` carry a message for this audience?
 *
 * Decided in TypeScript rather than in the query because the customer-facing
 * state is NULL (see `IntegrationAsset.purpose`), and a SQL `purpose <>
 * 'internal'` silently drops every NULL row -- which is every number registered
 * before the field existed, i.e. all of them in production.
 */
function carries(purpose: string | null, audience?: SenderAudience): boolean {
  if (!audience) return true;
  return audience === 'internal' ? purpose === 'internal' : purpose !== 'internal';
}
