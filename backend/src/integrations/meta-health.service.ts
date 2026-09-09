import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/auth-user';
import { MetaGraphClient, MetaGraphError } from './meta-graph.client';

/**
 * The five states an integration can be in. `not_configured` is the default a
 * row is created with; the others are only ever reached by evidence.
 */
export const CONNECTION_STATES = [
  'not_configured',
  'connected',
  'needs_attention',
  'failed',
  'disabled',
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/** Longest a stored provider error may be. Bounded so a Graph body cannot fill the column. */
const MAX_ERROR = 300;

/** Minimum gap between health checks for one integration, in milliseconds. */
const HEALTH_COOLDOWN_MS = 30_000;

/** Which Graph node answers for each asset kind, and the cheapest field to ask for. */
const ASSET_PROBE: Record<string, { field: string }> = {
  page: { field: 'id,name' },
  form: { field: 'id,name,status' },
  ad_account: { field: 'id,name,currency,account_status' },
  phone_number: { field: 'id' },
};

export interface AssetHealth {
  id: string;
  kind: string;
  externalId: string;
  name: string | null;
  verified: boolean;
  lastVerifiedAt: Date | null;
  error: string | null;
}

export interface IntegrationHealth {
  integrationId: string;
  providerCode: string;
  name: string;
  state: ConnectionState;
  lastHealthAt: Date | null;
  lastSyncAt: Date | null;
  error: string | null;
  credentialPresent: boolean;
  assets: AssetHealth[];
}

/**
 * Whether a tenant's integration actually works — as opposed to whether somebody
 * filled in the form.
 *
 * ## The distinction this service exists to make
 *
 * Storing a token proves a person pasted a string. Saving an asset id proves a
 * person typed a number. Neither proves the credential can read the Page, and an
 * administration screen that shows "connected" on that basis is lying to the
 * operator who then waits for leads that will never arrive. So:
 *
 *   - `status` becomes `connected` only after a live provider call succeeded;
 *   - `providerOwnershipVerified` becomes true only for the specific asset that
 *     call read back;
 *   - `lastHealthAt` is written only when a check actually ran.
 *
 * ## What never happens here
 *
 * The token is used and never returned, never logged, never stored anywhere but
 * its encrypted home. Provider errors are bounded and stripped before they reach
 * a column. And every query is tenant-scoped: a check runs against the caller's
 * own organisation, so one tenant can never probe another's assets.
 */
@Injectable()
export class MetaHealthService {
  private readonly logger = new Logger(MetaHealthService.name);
  private readonly lastRun = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: MetaGraphClient,
  ) {}

  /** Read the current state without contacting the provider. */
  async describe(user: AuthUser, integrationId: string): Promise<IntegrationHealth> {
    const integration = await this.load(user, integrationId);
    const [assets, credential] = await Promise.all([
      this.prisma.integrationAsset.findMany({
        where: { organisationId: user.organisationId, integrationId },
        orderBy: [{ kind: 'asc' }, { externalId: 'asc' }],
      }),
      this.prisma.integrationCredential.findFirst({
        where: { organisationId: user.organisationId, integrationId },
        // Presence only. The ciphertext is never selected, so it cannot leak
        // through a screen, a log or an error.
        select: { id: true },
      }),
    ]);

    return {
      integrationId: integration.id,
      providerCode: integration.providerCode,
      name: integration.name,
      state: this.stateOf(integration.status),
      lastHealthAt: integration.lastHealthAt,
      lastSyncAt: integration.lastSyncAt,
      error: integration.lastError,
      credentialPresent: Boolean(credential),
      assets: assets.map((a) => ({
        id: a.id,
        kind: a.kind,
        externalId: a.externalId,
        name: a.name,
        verified: a.providerOwnershipVerified,
        lastVerifiedAt: a.lastVerifiedAt,
        error: a.lastError,
      })),
    };
  }

  /**
   * Run a live check against the provider and record what it found.
   *
   * A deliberately disabled integration is left alone: an operator who switched
   * something off did so for a reason, and a background sweep flipping it back
   * to connected would undo that silently.
   */
  async check(user: AuthUser, integrationId: string): Promise<IntegrationHealth> {
    const integration = await this.load(user, integrationId);

    if (integration.status === 'disabled') {
      return this.describe(user, integrationId);
    }

    const key = `${user.organisationId}:${integrationId}`;
    const last = this.lastRun.get(key) ?? 0;
    if (Date.now() - last < HEALTH_COOLDOWN_MS) {
      // Rate-limited. Returning the stored state is honest — it says when the
      // check last ran — and it keeps a screen refresh from hammering Graph.
      return this.describe(user, integrationId);
    }
    this.lastRun.set(key, Date.now());

    const credential = await this.prisma.integrationCredential.findFirst({
      where: { organisationId: user.organisationId, integrationId },
      select: { id: true },
    });
    if (!credential) {
      await this.prisma.integration.update({
        where: { id: integrationId },
        data: {
          status: 'not_configured',
          lastHealthAt: new Date(),
          lastError: 'No access token has been stored for this integration.',
        },
      });
      return this.describe(user, integrationId);
    }

    const assets = await this.prisma.integrationAsset.findMany({
      where: { organisationId: user.organisationId, integrationId, isActive: true },
    });

    let verified = 0;
    let failures = 0;
    let credentialRejected = false;

    for (const asset of assets) {
      const probe = ASSET_PROBE[asset.kind];
      if (!probe) {
        // An asset kind this release cannot check. Say so rather than marking it
        // verified by omission.
        await this.markAsset(asset.id, false, `No ownership check exists for asset kind "${asset.kind}".`);
        failures += 1;
        continue;
      }
      try {
        const node = await this.graph.getForIntegration<{ id?: unknown }>(
          user.organisationId,
          integrationId,
          asset.externalId,
          { fields: probe.field },
        );
        // Reading *something* is not enough — it has to be the asset we asked
        // for. Graph can redirect an id, and a redirect is not ownership.
        const returned = node?.id == null ? '' : String(node.id);
        if (returned !== asset.externalId) {
          await this.markAsset(asset.id, false, 'Provider returned a different asset id than requested.');
          failures += 1;
          continue;
        }
        await this.markAsset(asset.id, true, null);
        verified += 1;
      } catch (err) {
        const message = this.bounded(err);
        if (this.isCredentialProblem(err)) credentialRejected = true;
        await this.markAsset(asset.id, false, message);
        failures += 1;
      }
    }

    /*
     * The integration's own state, derived from what the assets said.
     *
     * A rejected or expired credential is `failed`: nothing will work until
     * somebody replaces it. A working credential that cannot read every asset is
     * `needs_attention` — the connection is alive but incomplete, which is a
     * different job for a different person. No assets at all is
     * `not_configured`, because a token with nothing to read does nothing.
     */
    const state: ConnectionState = credentialRejected
      ? 'failed'
      : assets.length === 0
        ? 'not_configured'
        : failures > 0
          ? 'needs_attention'
          : 'connected';

    await this.prisma.integration.update({
      where: { id: integrationId },
      data: {
        status: state,
        lastHealthAt: new Date(),
        lastError:
          state === 'connected'
            ? null
            : credentialRejected
              ? 'The stored access token was rejected by the provider.'
              : assets.length === 0
                ? 'No assets have been registered for this integration.'
                : `${failures} of ${assets.length} assets could not be verified.`,
      },
    });

    this.logger.log(
      `Meta health for integration ${integrationId}: ${state} (${verified}/${assets.length} assets verified)`,
    );
    return this.describe(user, integrationId);
  }

  private async markAsset(id: string, verified: boolean, error: string | null) {
    await this.prisma.integrationAsset.update({
      where: { id },
      data: {
        providerOwnershipVerified: verified,
        // Written on every completed check, pass or fail, so a screen can say
        // how fresh the verdict is.
        lastVerifiedAt: new Date(),
        lastError: error,
      },
    });
  }

  private async load(user: AuthUser, integrationId: string) {
    if (user.role !== 'head_office') {
      throw new ForbiddenException('Only head office can inspect integration health.');
    }
    const integration = await this.prisma.integration.findFirst({
      // Tenant-scoped by the same query that fetches it, so a caller cannot
      // probe another organisation's integration by guessing its id.
      where: { id: integrationId, organisationId: user.organisationId },
    });
    if (!integration) throw new NotFoundException('Integration not found');
    return integration;
  }

  private stateOf(status: string): ConnectionState {
    return (CONNECTION_STATES as readonly string[]).includes(status)
      ? (status as ConnectionState)
      : 'not_configured';
  }

  /** A token or permission problem, as opposed to a missing or renamed asset. */
  private isCredentialProblem(err: unknown): boolean {
    if (!(err instanceof MetaGraphError)) return false;
    const text = `${err.message}`.toLowerCase();
    return (
      text.includes('access token') ||
      text.includes('oauth') ||
      text.includes('expired') ||
      text.includes('permission') ||
      text.includes('unauthorized') ||
      text.includes('not configured')
    );
  }

  /**
   * A provider error safe to store.
   *
   * Truncated, and stripped of anything that looks like a bearer token or a
   * token query parameter — a Graph error body can echo the request back.
   */
  private bounded(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return raw
      .replace(/access_token=[^&\s]+/gi, 'access_token=[redacted]')
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]')
      .slice(0, MAX_ERROR);
  }
}
