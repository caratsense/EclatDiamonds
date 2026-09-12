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

/** Where a send is going, so the right number can be chosen for it. */
export interface SenderRoute {
  /** The asset a conversation already belongs to. Highest authority. */
  assetId?: string | null;
  /** The branch the message is on behalf of. */
  storeId?: string | null;
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
      return this.unusable('tenant', chosen.reason, chosen.integrationId ?? null);
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
   */
  private async chooseAsset(
    organisationId: string,
    route: SenderRoute,
  ): Promise<ChosenSender | { reason: string; integrationId?: string | null }> {
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
        select: { id: true, externalId: true, integrationId: true },
      });
      if (pinned) {
        return { asset: pinned, resolvedBy: 'thread', storeId: route.storeId ?? null };
      }
      // The number this thread arrived on has since been retired, or its account
      // disabled. Falling through is the lesser harm: the alternative is never
      // answering the customer at all. `resolvedBy` reports whatever was used
      // instead, so the substitution is visible rather than silent.
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
      select: { id: true, externalId: true, integrationId: true },
      orderBy: { createdAt: 'asc' },
    });

    if (active.length === 1) {
      return { asset: active[0], resolvedBy: 'only_number', storeId: route.storeId ?? null };
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
    return {
      reason:
        `This organisation has ${active.length} WhatsApp numbers connected and ` +
        `${
          route.storeId
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
      );
    }
    if (credential.expiresAt && credential.expiresAt.getTime() < Date.now()) {
      return this.unusable(
        'tenant',
        `The stored WhatsApp token expired on ${credential.expiresAt
          .toISOString()
          .slice(0, 10)}. Replace it to resume sending.`,
        integrationId,
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
  ): WhatsAppSender {
    return {
      usable: false,
      scope,
      accessToken: null,
      phoneNumberId: null,
      integrationId,
      reason,
      shared: false,
      assetId: null,
      resolvedBy: null,
      storeId: null,
    };
  }
}
