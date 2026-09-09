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
  async senderFor(organisationId: string): Promise<WhatsAppSender> {
    // ---------------------------------------------------------- 1. tenant
    const integration = await this.prisma.integration.findFirst({
      where: {
        organisationId,
        providerCode: WHATSAPP_PROVIDER_CODE,
        status: { notIn: ['disabled'] },
      },
      include: {
        credentials: { where: { kind: 'access_token' } },
        assets: { where: { kind: 'phone_number', isActive: true }, orderBy: { createdAt: 'asc' } },
      },
    });

    if (integration) {
      const credential = integration.credentials[0];
      const asset = integration.assets[0];

      if (!credential) {
        return this.unusable(
          'tenant',
          'A WhatsApp integration exists but no access token has been saved for it.',
          integration.id,
        );
      }
      if (!asset) {
        return this.unusable(
          'tenant',
          'A WhatsApp integration exists but no phone number has been registered against it.',
          integration.id,
        );
      }
      if (credential.expiresAt && credential.expiresAt.getTime() < Date.now()) {
        return this.unusable(
          'tenant',
          `The stored WhatsApp token expired on ${credential.expiresAt.toISOString().slice(0, 10)}. Replace it to resume sending.`,
          integration.id,
        );
      }

      try {
        const encrypted = {
          ciphertext: credential.ciphertext,
          iv: credential.iv,
          authTag: credential.authTag,
          keyVersion: credential.keyVersion,
        };
        const context = {
          organisationId,
          integrationId: integration.id,
          kind: 'access_token',
        };
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
          phoneNumberId: asset.externalId,
          integrationId: integration.id,
          reason: null,
          shared: false,
        };
      } catch (e) {
        // A credential that will not decrypt is a real, actionable state — a
        // rotated master key, a corrupted row — and saying so is far better than
        // quietly falling through to the platform number and sending as someone
        // else's business.
        return this.unusable(
          'tenant',
          `The stored WhatsApp token could not be decrypted (${e instanceof Error ? e.message : 'unknown error'}). It must be re-entered.`,
          integration.id,
        );
      }
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
      'No WhatsApp number is connected for this organisation. Connect one under Settings → Integrations.',
      null,
    );
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
        organisationId: true,
        integrationId: true,
        integration: { select: { organisationId: true } },
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
        ? { organisationId: boundOrg, integrationId: null, scope: 'platform_env' }
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
    return {
      organisationId: parentOrganisationId,
      integrationId: asset.integrationId,
      scope: 'tenant',
    };
  }

  /** Sender state for a settings screen, with no secret in the payload. */
  async describeFor(organisationId: string) {
    const sender = await this.senderFor(organisationId);
    return {
      usable: sender.usable,
      scope: sender.scope,
      shared: sender.shared,
      reason: sender.reason,
      integrationId: sender.integrationId,
      // The last four digits only — enough to confirm which number is connected,
      // useless to anyone who intercepts it.
      phoneNumberIdSuffix: sender.phoneNumberId ? `…${sender.phoneNumberId.slice(-4)}` : null,
      oauth: {
        implemented: false,
        note: 'Meta’s embedded signup flow has not been verified against live provider documentation, so tokens are entered by hand today. The stored credential format already supports an OAuth access/refresh pair.',
      },
    };
  }

  private unusable(scope: CredentialScope, reason: string, integrationId: string | null): WhatsAppSender {
    return {
      usable: false,
      scope,
      accessToken: null,
      phoneNumberId: null,
      integrationId,
      reason,
      shared: false,
    };
  }
}
