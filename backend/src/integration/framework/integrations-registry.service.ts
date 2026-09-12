import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/auth-user';
import { CredentialCrypto } from './credential-crypto';
import { getProvider, listProviders, platformScopedProviders } from './provider-registry';
import { tenantAllows } from '../../config/entitlements';

/**
 * IntegrationsRegistryService — a tenant's connections and their secrets
 * (CaratOS Phase A5).
 *
 * Named "Registry" to stay distinct from the existing `IntegrationsService`
 * (src/integrations/, the WhatsApp/Razorpay/gold-rate channel services) and the
 * existing `ImportService`. This owns *configuration*: which providers a tenant
 * has connected and the credentials for them. It does not talk to any provider.
 *
 * A SECRET IS NEVER RETURNED. Not on create, not on read, not to head office.
 * `hasCredential` and `lastUsedAt` are the only things a caller learns. The
 * decrypt path is internal (`credentialFor`) and reachable only by server-side
 * adapters — there is no endpoint that reveals one.
 */
@Injectable()
export class IntegrationsRegistryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CredentialCrypto,
    private readonly audit: AuditService,
    private readonly config?: ConfigService,
  ) {}

  /**
   * The provider catalogue, plus this deployment's honest state.
   *
   * `platformScopedWarning` is surfaced in the API on purpose: an operator
   * connecting a second tenant needs to be told, in the product, that WhatsApp
   * and Razorpay credentials are currently deployment-wide.
   */
  catalogue(user: AuthUser) {
    const platformScoped = platformScopedProviders();
    return {
      /*
       * Filtered to what this tenant's modules can actually use.
       *
       * A clinic was being offered a "Gold rate feed" — connectable, and then
       * permanently inert, because the module that reads a metal rate is not in
       * their product. A catalogue that lists it is not merely untidy: it is the
       * same class of claim as an integration reporting itself connected because
       * an environment variable exists.
       *
       * The provider names its own requirement; this does not know about gold.
       */
      providers: listProviders()
        .filter(
          (p) =>
            !p.requiresCapability ||
            tenantAllows(
              user.industryPackCode,
              user.disabledCapabilities,
              p.requiresCapability,
            ),
        )
        .map((p) => ({
          code: p.code,
          name: p.name,
          category: p.category,
          description: p.description,
          available: p.available,
          blockedReason: p.blockedReason ?? null,
          credentialScope: p.credentialScope,
          credentialKinds: p.credentialKinds ?? [],
          entities: p.entities ?? [],
          webhooks: !!p.webhooks,
        })),
      encryption: {
        configured: this.crypto.isConfigured,
        note: this.crypto.isConfigured
          ? 'Tenant credentials are encrypted at rest (AES-256-GCM).'
          : 'CREDENTIAL_ENCRYPTION_KEY is not set. Tenant credentials cannot be saved — ' +
            'they are never written unencrypted.',
      },
      platformScopedWarning: platformScoped.length
        ? {
            providers: platformScoped.map((p) => p.code),
            message:
              `${platformScoped.map((p) => p.name).join(' and ')} still read their credentials ` +
              `from this deployment's environment, so every organisation on this deployment ` +
              `shares one account. Move them to per-organisation credentials before a second ` +
              `organisation uses them.`,
          }
        : null,
      organisationId: user.organisationId,
    };
  }

  async list(user: AuthUser) {
    const rows = await this.prisma.integration.findMany({
      where: { organisationId: user.organisationId },
      orderBy: [{ providerCode: 'asc' }, { name: 'asc' }],
      include: {
        credentials: { select: { kind: true, expiresAt: true, rotatedAt: true, lastUsedAt: true } },
        assets: { where: { isActive: true }, select: { id: true, kind: true, externalId: true, name: true } },
      },
    });
    return rows.map((r) => this.present(r));
  }

  async get(user: AuthUser, id: string) {
    const row = await this.prisma.integration.findFirst({
      where: { id, organisationId: user.organisationId },
      include: {
        credentials: { select: { kind: true, expiresAt: true, rotatedAt: true, lastUsedAt: true } },
        assets: { where: { isActive: true } },
      },
    });
    if (!row) throw new NotFoundException('Integration not found');
    return this.present(row);
  }

  /**
   * Replace the non-secret settings of an existing connection.
   *
   * Connections were creatable with settings and then frozen, so an account id
   * a tenant learns after connecting — a WhatsApp Business Account, say — could
   * never be recorded without deleting and rebuilding the connection, which
   * would take its encrypted credential with it.
   *
   * The same guard as `create` runs here: anything credential-shaped is refused
   * rather than written in the clear, because this column is readable by every
   * administration screen.
   */
  async updateConfig(user: AuthUser, id: string, config: Prisma.InputJsonValue) {
    assertNonSecretIntegrationConfig(config);
    const integration = await this.load(user, id);
    await this.prisma.integration.update({ where: { id: integration.id }, data: { config } });
    await this.audit.record(user, {
      action: 'integration.config_updated',
      entityType: 'Integration',
      entityId: integration.id,
      summary: `Updated settings for "${integration.name}".`,
      // The keys that changed, never their values: a setting is non-secret by
      // rule, not by proof, and an audit row is the wrong place to test that.
      metadata: { providerCode: integration.providerCode, fields: Object.keys(config ?? {}).sort() },
    });
    return this.get(user, id);
  }

  async create(
    user: AuthUser,
    input: { providerCode: string; name: string; config?: Prisma.InputJsonValue },
  ) {
    assertNonSecretIntegrationConfig(input.config);
    const provider = getProvider(input.providerCode);
    if (!provider) {
      throw new BadRequestException(`Unknown provider "${input.providerCode}".`);
    }
    if (!provider.available) {
      // Refused, not created-and-disabled: a row for something that cannot work
      // would show up in the UI as a connection the tenant might expect to run.
      throw new BadRequestException(
        `${provider.name} cannot be connected. ${provider.blockedReason ?? 'It is not implemented.'}`,
      );
    }
    if (provider.credentialScope === 'on_premise') {
      // On-premise sources authenticate as Connect agents. Creating a generic
      // Integration row here would not enrol an agent or make the source run,
      // while still looking connected to an operator.
      throw new BadRequestException(
        `${provider.name} uses an on-premise Connect agent. Enrol it from Data & Imports.`,
      );
    }
    if (provider.credentialScope === 'platform_env') {
      throw new BadRequestException(
        `${provider.name} is configured by the platform operator in deployment secrets and cannot be connected per tenant yet.`,
      );
    }

    const existing = await this.prisma.integration.findUnique({
      where: {
        organisationId_providerCode_name: {
          organisationId: user.organisationId,
          providerCode: input.providerCode,
          name: input.name,
        },
      },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException(`You already have a "${input.name}" ${provider.name} connection.`);
    }

    const created = await this.prisma.integration.create({
      data: {
        organisationId: user.organisationId,
        providerCode: input.providerCode,
        name: input.name,
        config: input.config,
        capabilities: (provider.entities ?? []) as unknown as Prisma.InputJsonValue,
        status: 'not_configured',
        createdById: user.id,
      },
      include: { credentials: true, assets: true },
    });
    await this.audit.record(user, {
      action: 'integration.created',
      entityType: 'Integration',
      entityId: created.id,
      summary: `Connected ${provider.name} as "${input.name}"`,
    });
    return this.present(created);
  }

  /**
   * Store or replace a secret. The plaintext is encrypted immediately and never
   * written anywhere else — not to the audit log, not to the response.
   */
  async setCredential(user: AuthUser, integrationId: string, kind: string, secret: string) {
    const integration = await this.load(user, integrationId);
    const provider = getProvider(integration.providerCode);
    if (!provider || provider.credentialScope !== 'tenant') {
      throw new BadRequestException(
        `${provider?.name ?? integration.providerCode} does not consume tenant-stored credentials.`,
      );
    }
    if (!provider.credentialKinds?.includes(kind)) {
      throw new BadRequestException(
        `${provider.name} does not use a "${kind}" credential. Expected: ${(provider.credentialKinds ?? []).join(', ') || 'none'}.`,
      );
    }
    if (!secret?.trim()) throw new BadRequestException('The secret is empty.');

    // Throws when no key is configured — the integration simply cannot be saved.
    const credentialContext = {
      organisationId: user.organisationId,
      integrationId,
      kind,
    };
    const sealed = this.crypto.encrypt(secret, credentialContext);

    await this.prisma.integrationCredential.upsert({
      where: { integrationId_kind: { integrationId, kind } },
      create: {
        organisationId: user.organisationId,
        integrationId,
        kind,
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        authTag: sealed.authTag,
        keyVersion: sealed.keyVersion,
      },
      update: {
        // Repair any historical denormalised tenant id to the organisation of
        // the already-authorised parent Integration.
        organisationId: user.organisationId,
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        authTag: sealed.authTag,
        keyVersion: sealed.keyVersion,
        rotatedAt: new Date(),
      },
    });

    await this.audit.record(user, {
      action: 'integration.credential_set',
      entityType: 'Integration',
      entityId: integrationId,
      // The KIND is audited; the VALUE never is.
      summary: `Updated the ${kind} for "${integration.name}"`,
      metadata: { kind, keyVersion: sealed.keyVersion },
    });
    return { stored: true, kind, keyVersion: sealed.keyVersion };
  }

  async deleteCredential(user: AuthUser, integrationId: string, kind: string) {
    const integration = await this.load(user, integrationId);
    const deleted = await this.prisma.integrationCredential.deleteMany({
      where: { integrationId, kind, organisationId: user.organisationId },
    });
    if (!deleted.count) throw new NotFoundException('Credential not found');
    await this.audit.record(user, {
      action: 'integration.credential_removed',
      entityType: 'Integration',
      entityId: integrationId,
      summary: `Removed the ${kind} from "${integration.name}"`,
    });
    return { removed: true };
  }

  /** Register the non-secret provider identity paired with a tenant credential. */
  async setAsset(
    user: AuthUser,
    integrationId: string,
    input: { kind: string; externalId: string; name?: string },
  ) {
    const integration = await this.load(user, integrationId);
    if (integration.providerCode !== 'whatsapp_cloud' || input.kind !== 'phone_number') {
      throw new BadRequestException(
        'This integration does not accept that tenant-managed asset.',
      );
    }
    const externalId = input.externalId.trim();
    if (!/^[1-9]\d{5,31}$/.test(externalId)) {
      throw new BadRequestException('WhatsApp phone number ID must contain 6 to 32 digits.');
    }
    const platformPhoneNumberId =
      this.config?.get<string>('WHATSAPP_PHONE_NUMBER_ID')?.trim() ?? '';
    if (platformPhoneNumberId && platformPhoneNumberId === externalId) {
      throw new BadRequestException(
        'That WhatsApp phone number ID belongs to the platform sender. Remove the platform binding before registering it to a tenant.',
      );
    }
    const name = input.name?.trim() || null;
    const ownershipKey = whatsappPhoneOwnershipKey(externalId);

    let asset: {
      id: string;
      kind: string;
      externalId: string;
      name: string | null;
      isActive: boolean;
    } | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        asset = await this.prisma.$transaction(
          async (tx) => {
            const conflictingOwner = await tx.integrationAsset.findFirst({
              where: {
                kind: 'phone_number',
                externalId,
                isActive: true,
                integration: { providerCode: 'whatsapp_cloud' },
                NOT: { integrationId },
              },
              select: { id: true },
            });
            if (conflictingOwner) {
              throw new BadRequestException(
                'That WhatsApp phone number ID is already registered to another connection.',
              );
            }
            // ONE ACTIVE SENDER PER CONNECTION WAS LIFTED HERE, deliberately.
            //
            // This block used to deactivate every other phone number on the
            // connection, so registering a second number silently switched the
            // first one off. That was a real simplification while a tenant had
            // one number; a business with eight across two WABA accounts cannot
            // express itself at all under it, and the failure was invisible —
            // the branch whose number had just been deactivated simply started
            // sending as somebody else.
            //
            // What is NOT relaxed is the property that actually matters: the
            // unique `ownershipKey` still allows exactly one ACTIVE claim on a
            // given phone-number id across the whole platform, so two tenants
            // can never both own an inbound routing identity. Serializable
            // isolation and the P2002 branch below remain the guard for
            // concurrent first-time registrations of the SAME number.
            //
            // Which of a tenant's own numbers a branch sends from is now a
            // routing decision (StoreMessagingRoute), which is where it belongs:
            // it is a business choice, not a database constraint.
            return tx.integrationAsset.upsert({
              where: {
                integrationId_kind_externalId: {
                  integrationId,
                  kind: 'phone_number',
                  externalId,
                },
              },
              create: {
                organisationId: user.organisationId,
                integrationId,
                kind: 'phone_number',
                externalId,
                name,
                metadata: { providerOwnershipVerified: false },
                isActive: true,
                ownershipKey,
              },
              update: {
                organisationId: user.organisationId,
                name,
                metadata: { providerOwnershipVerified: false },
                isActive: true,
                ownershipKey,
              },
              select: { id: true, kind: true, externalId: true, name: true, isActive: true },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        break;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'P2002') {
          throw new BadRequestException(
            'That WhatsApp phone number ID is already registered to another connection.',
          );
        }
        if (code !== 'P2034' || attempt === 2) throw error;
      }
    }
    if (!asset) throw new InternalServerErrorException('WhatsApp sender registration did not finish.');

    await this.audit.record(user, {
      action: 'integration.asset_set',
      entityType: 'Integration',
      entityId: integrationId,
      summary: `Registered a WhatsApp phone-number identity for "${integration.name}".`,
      // Provider ownership cannot be proven without a live Meta token/API call.
      // Keep that gate explicit instead of presenting fixture validation as live.
      metadata: { kind: 'phone_number', providerOwnershipVerified: false },
    });
    return { ...asset, providerOwnershipVerified: false };
  }

  /**
   * INTERNAL — decrypt a credential for a server-side adapter.
   *
   * There is deliberately no controller route that reaches this. Takes an
   * organisationId (not an AuthUser) because a background job legitimately has no
   * user, but it still cannot read across tenants: the query is bounded by the
   * organisation the job was bound to.
   */
  async credentialFor(
    organisationId: string,
    integrationId: string,
    kind: string,
  ): Promise<string | null> {
    const row = await this.prisma.integrationCredential.findFirst({
      where: {
        integrationId,
        kind,
        organisationId,
        integration: { organisationId },
      },
    });
    if (!row) return null;
    const context = { organisationId, integrationId, kind };
    const plaintext = this.crypto.decrypt(row, context);
    // Cryptographically test ACTIVE as well as metadata. This heals the common
    // operator error where the key changed but VERSION was not incremented.
    const needsUpgrade = !this.crypto.isEncryptedWithActiveKey(row, context);
    const upgraded = needsUpgrade ? this.crypto.encrypt(plaintext, context) : null;
    // Best-effort usage stamp and in-place legacy upgrade. The ciphertext
    // predicate prevents this read from overwriting a concurrent rotation.
    await this.prisma.integrationCredential
      .updateMany({
        where: { id: row.id, ciphertext: row.ciphertext },
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
    return plaintext;
  }

  /**
   * Re-wrap every credential owned by this tenant with the active key/context.
   *
   * Operators run this while ACTIVE + PREVIOUS are both configured, then repeat
   * until `complete` is true before removing PREVIOUS. The ciphertext predicate
   * fences a concurrent human credential replacement; a re-wrap can never put
   * an older plaintext back over a newly saved secret.
   */
  async rewrapCredentials(user: AuthUser) {
    this.crypto.assertConfigured();
    const activeVersion = this.crypto.activeVersion;
    const rows = await this.prisma.integrationCredential.findMany({
      // Scope through the authoritative parent. The duplicated credential tenant
      // id may be stale in historical data and must not make a row disappear from
      // this tenant's completion result.
      where: { integration: { organisationId: user.organisationId } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        organisationId: true,
        integrationId: true,
        kind: true,
        ciphertext: true,
        iv: true,
        authTag: true,
        keyVersion: true,
        integration: { select: { organisationId: true } },
      },
    });

    let current = 0;
    let rewrapped = 0;
    let concurrent = 0;
    let failed = 0;
    for (const row of rows) {
      if (row.integration.organisationId !== user.organisationId) {
        failed += 1;
        continue;
      }
      const context = {
        organisationId: user.organisationId,
        integrationId: row.integrationId,
        kind: row.kind,
      };
      const tenantIdConsistent = row.organisationId === user.organisationId;
      if (tenantIdConsistent && this.crypto.isEncryptedWithActiveKey(row, context)) {
        current += 1;
        continue;
      }
      try {
        const plaintext = this.crypto.decrypt(row, context);
        const sealed = this.crypto.encrypt(plaintext, context);
        const result = await this.prisma.integrationCredential.updateMany({
          where: {
            id: row.id,
            ciphertext: row.ciphertext,
            integration: { organisationId: user.organisationId },
          },
          data: {
            // Repair a historical denormalised tenant id only after the row has
            // decrypted under the authoritative parent tenant's AAD context.
            organisationId: user.organisationId,
            ciphertext: sealed.ciphertext,
            iv: sealed.iv,
            authTag: sealed.authTag,
            keyVersion: sealed.keyVersion,
          },
        });
        if (result.count === 1) rewrapped += 1;
        else concurrent += 1;
      } catch {
        // Never expose which row or why: driver/decryption details can reveal
        // storage internals. The aggregate failure count is actionable and the
        // immutable audit event proves the attempted operation.
        failed += 1;
      }
    }

    const result = {
      scanned: rows.length,
      current,
      rewrapped,
      concurrent,
      failed,
      activeVersion,
      complete: failed === 0 && concurrent === 0,
    };
    await this.audit.record(user, {
      action: 'integration.credentials_rewrapped',
      entityType: 'Organisation',
      entityId: user.organisationId,
      summary: `Credential envelope re-wrap scanned ${rows.length} row(s): ${rewrapped} changed, ${failed} failed, ${concurrent} changed concurrently.`,
      metadata: result,
    });
    return result;
  }

  /** Record the outcome of a health check or sync attempt. */
  async recordHealth(
    organisationId: string,
    integrationId: string,
    outcome: { status: string; error?: string | null; watermark?: string | null; synced?: boolean },
  ) {
    const owned = await this.prisma.integration.findFirst({
      where: { id: integrationId, organisationId },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException('Integration not found');
    return this.prisma.integration.update({
      where: { id: integrationId },
      data: {
        status: outcome.status,
        lastError: outcome.error ?? null,
        lastHealthAt: new Date(),
        ...(outcome.synced ? { lastSyncAt: new Date() } : {}),
        ...(outcome.watermark !== undefined ? { watermark: outcome.watermark } : {}),
      },
    });
  }

  async remove(user: AuthUser, id: string) {
    const integration = await this.load(user, id);
    // Cascades to credentials and assets — deleting a connection must not leave
    // its secrets behind as orphans.
    await this.prisma.integration.delete({ where: { id } });
    await this.audit.record(user, {
      action: 'integration.removed',
      entityType: 'Integration',
      entityId: id,
      summary: `Disconnected "${integration.name}"`,
    });
    return { removed: true };
  }

  private async load(user: AuthUser, id: string) {
    const row = await this.prisma.integration.findFirst({
      where: { id, organisationId: user.organisationId },
    });
    if (!row) throw new NotFoundException('Integration not found');
    return row;
  }

  /** Shape an integration for the API. Secrets are reduced to their existence. */
  private present(row: {
    id: string;
    providerCode: string;
    name: string;
    status: string;
    config: Prisma.JsonValue | null;
    lastHealthAt: Date | null;
    lastSyncAt: Date | null;
    lastError: string | null;
    watermark: string | null;
    createdAt: Date;
    credentials?: { kind: string; expiresAt: Date | null; rotatedAt: Date | null; lastUsedAt: Date | null }[];
    assets?: unknown[];
  }) {
    const provider = getProvider(row.providerCode);
    const state = resolveState(row, provider);
    return {
      id: row.id,
      providerCode: row.providerCode,
      providerName: provider?.name ?? row.providerCode,
      credentialScope: provider?.credentialScope ?? 'tenant',
      name: row.name,
      /** The stored status, unchanged — what the last health check wrote. */
      status: row.status,
      /**
       * The state a UI should render, DERIVED (Phase A5 completion).
       *
       * Distinct from `status` on purpose. `status` records what happened last
       * time we talked to the provider; `state` answers "what can this tenant do
       * right now", which also depends on whether a credential exists, whether
       * it has expired, and whether the provider is blocked at the platform
       * level. Collapsing the two would mean a provider nobody can use still
       * reading "connected" because its last sync happened to succeed.
       */
      state: state.state,
      /** Always a sentence, so the frontend never has to invent an explanation. */
      stateReason: state.reason,
      config: row.config,
      lastHealthAt: row.lastHealthAt,
      lastSyncAt: row.lastSyncAt,
      lastError: row.lastError,
      watermark: row.watermark,
      createdAt: row.createdAt,
      // Kind + freshness only. The secret itself has no representation here.
      credentials: (row.credentials ?? []).map((c) => ({
        kind: c.kind,
        present: true,
        expiresAt: c.expiresAt,
        rotatedAt: c.rotatedAt,
        lastUsedAt: c.lastUsedAt,
      })),
      assets: row.assets ?? [],
    };
  }
}

/**
 * Integration.config is returned to administrators and stored as ordinary
 * JSON. Reject credential-shaped keys at every depth so callers cannot bypass
 * the encrypted credential endpoint by hiding a token in this public bag.
 * The traversal budget also keeps an otherwise-valid JSON body cheap to audit.
 */
export function assertNonSecretIntegrationConfig(value: unknown): void {
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 1_000 || depth > 8) {
      throw new BadRequestException('Integration config is too deeply nested or complex.');
    }
    if (current == null || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      if (current.length > 200) {
        throw new BadRequestException('Integration config arrays may contain at most 200 items.');
      }
      current.forEach((item) => visit(item, depth + 1));
      return;
    }
    const entries = Object.entries(current as Record<string, unknown>);
    if (entries.length > 100) {
      throw new BadRequestException('Integration config objects may contain at most 100 fields.');
    }
    const normalizedEntries = new Map<string, unknown>();
    for (const [key, item] of entries) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normalizedEntries.has(normalized)) {
        throw new BadRequestException(
          `Integration config contains duplicate field names after normalisation ("${key}").`,
        );
      }
      normalizedEntries.set(normalized, item);
    }
    const declaredDiscriminators = [
      normalizedEntries.get('kind'),
      normalizedEntries.get('type'),
    ];
    if (
      declaredDiscriminators.some(
        (declared) =>
          typeof declared === 'string' &&
          /(?:token|password|passwd|passphrase|secret|credential|privatekey|apikey|accesskey)/.test(
            declared.toLowerCase().replace(/[^a-z0-9]/g, ''),
          ),
      ) &&
      ['value', 'data', 'content', 'secret'].some((key) => normalizedEntries.has(key))
    ) {
      throw new BadRequestException(
        'Integration config contains a credential-shaped kind/value object. Store it through the encrypted credentials endpoint.',
      );
    }
    for (const [key, item] of entries) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (
        /(?:password|passwd|passphrase|secret|credential|privatekey)/.test(normalized) ||
        /(?:^|access|refresh|auth|bearer|api|client)token$/.test(normalized) ||
        /(?:apikey|accesskey|clientkey)$/.test(normalized) ||
        normalized === 'authorization' ||
        normalized === 'connectionstring' ||
        normalized === 'databaseurl'
      ) {
        throw new BadRequestException(
          `Integration config field "${key}" looks like a credential. Store it through the encrypted credentials endpoint.`,
        );
      }
      if (typeof item === 'string' && looksLikeEmbeddedCredential(item)) {
        throw new BadRequestException(
          `Integration config field "${key}" contains an embedded credential. Store it through the encrypted credentials endpoint.`,
        );
      }
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
}

function whatsappPhoneOwnershipKey(externalId: string): string {
  return `whatsapp_cloud:phone_number:${externalId}`;
}

function looksLikeEmbeddedCredential(value: string): boolean {
  if (/^\s*(?:basic|bearer)\s+\S+/i.test(value)) return true;
  if (
    /(?:^|[;?&\s])(?:pwd|password|passwd|passphrase|token|access[_-]?token|api[_-]?key|client[_-]?secret|authorization)\s*=/i.test(
      value,
    )
  ) {
    return true;
  }
  // User-info in a URL is a credential even when the surrounding key is called
  // merely `endpoint` or `url`.
  try {
    const parsed = new URL(value);
    return Boolean(parsed.username || parsed.password);
  } catch {
    return false;
  }
}


/**
 * The six states an integration can be in, and how each is reached.
 *
 * Ordered by precedence — the FIRST match wins, and the order is the point:
 * a blocked provider is blocked no matter how healthy its last sync looked, and
 * a missing credential outranks a stale error because it is the thing the user
 * has to fix first.
 */
export type IntegrationState =
  | 'not_configured'
  | 'configuring'
  | 'connected'
  | 'degraded'
  | 'disconnected'
  | 'blocked';

export function resolveState(
  row: {
    status: string;
    lastError: string | null;
    lastHealthAt: Date | null;
    credentials?: { kind: string; expiresAt: Date | null }[];
  },
  provider: { available?: boolean; blockedReason?: string | null; credentialScope?: string } | undefined,
): { state: IntegrationState; reason: string } {
  if (provider && provider.available === false) {
    return {
      state: 'blocked',
      reason:
        provider.blockedReason ??
        'This provider is not available yet. Nothing can be connected until it is.',
    };
  }
  if (row.status === 'disabled') {
    return { state: 'disconnected', reason: 'Switched off for this organisation.' };
  }

  const credentials = row.credentials ?? [];
  // A provider that needs no secret (a public feed, a file upload) is not
  // "missing a credential" — treating it as unconfigured would leave it
  // permanently amber with nothing to fix.
  const needsCredential = provider?.credentialScope === 'tenant';
  if (needsCredential && credentials.length === 0) {
    return {
      state: 'configuring',
      reason: 'Set up but not finished — no credential has been saved yet.',
    };
  }
  const expired = credentials.find((c) => c.expiresAt && c.expiresAt.getTime() < Date.now());
  if (expired) {
    return {
      state: 'disconnected',
      reason: `The stored ${expired.kind.replace(/_/g, ' ')} expired on ${expired.expiresAt!
        .toISOString()
        .slice(0, 10)}. Replace it to reconnect.`,
    };
  }
  if (row.status === 'failed') {
    return { state: 'disconnected', reason: row.lastError ?? 'The last attempt to reach this provider failed.' };
  }
  if (row.status === 'needs_attention') {
    return {
      state: 'degraded',
      reason: row.lastError ?? 'Working, but the last run reported problems.',
    };
  }
  if (row.status === 'connected') {
    return { state: 'connected', reason: 'Working normally.' };
  }
  if (needsCredential && credentials.length > 0) {
    return {
      state: 'configuring',
      reason: 'Credential saved; the provider connection has not been verified yet.',
    };
  }
  return {
    state: 'not_configured',
    reason: 'Nothing has been connected yet.',
  };
}
