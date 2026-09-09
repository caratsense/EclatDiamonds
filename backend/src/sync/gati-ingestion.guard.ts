import {
  applyDecorators,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AllowMachine } from '../auth/machine.decorator';
import { AuthUser } from '../common/auth-user';
import { PrismaService } from '../prisma/prisma.service';

export const GATI_PROFILE_ID_HEADER = 'x-caratos-profile-id';
export const GATI_PROFILE_HASH_HEADER = 'x-caratos-profile-hash';
export const GATI_SOURCE_INSTANCE_HASH_HEADER = 'x-caratos-source-instance-hash';
export const GATI_CONFIG_REVISION_HEADER = 'x-caratos-config-revision';

const SHA256_RE = /^[a-f0-9]{64}$/;
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9._-]{1,79}$/;
const CONFIG_REVISION_RE = /^[A-Za-z0-9._-]{1,80}$/;
const BRANCH_COLUMN_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

export const GATI_ROUTABLE_ENTITIES = ['parties', 'products', 'stock', 'sales', 'orders', 'ledger'] as const;

type GatiRoutableEntity = (typeof GATI_ROUTABLE_ENTITIES)[number];

/**
 * Routing settings copied from the server-approved agent generation.
 *
 * `undefined` means an older Eclat enrollment did not carry that key and may
 * use the process environment as a compatibility fallback. `null` is an
 * explicit head-office decision that there is no default store; it must never
 * silently fall through to another tenant's process-global value.
 */
export interface GatiRoutingPolicy {
  defaultStoreId: string | null | undefined;
  unattributedMode: 'holding' | 'default' | undefined;
  branchColumns: Partial<Record<GatiRoutableEntity, readonly string[]>> | undefined;
}

/** Immutable identity/config generation carried from the guard to SyncService. */
export interface GatiIngestionContext {
  agentId: string;
  organisationId: string;
  tokenHash: string;
  configRevision: string;
  profileId: string;
  profileHash: string;
  sourceInstanceHash: string;
  routing: GatiRoutingPolicy;
}

type HeaderValue = string | string[] | undefined;

type GatiRequest = {
  user?: AuthUser;
  headers: Record<string, HeaderValue>;
  gatiIngestion?: GatiIngestionContext;
};

/** The guard-authenticated generation. No value is accepted from a body/header here. */
export const CurrentGatiIngestion = createParamDecorator(
  (_data: unknown, context: ExecutionContext): GatiIngestionContext => {
    const request = context.switchToHttp().getRequest<GatiRequest>();
    if (!request.gatiIngestion) {
      throw new ForbiddenException('Legacy Gati ingestion generation was not established.');
    }
    return request.gatiIngestion;
  },
);

/** Mark a legacy Gati write and apply its post-authentication identity gate. */
export const GatiIngestion = () => applyDecorators(AllowMachine('gati'), UseGuards(GatiIngestionGuard));

/**
 * Fail-closed request binding for the legacy `/sync/*` push surface.
 *
 * The bearer token selects the tenant and enrolled machine. These headers bind
 * this particular write to the profile, source descriptor and server config
 * generation that head office approved. They are controls carried by the same
 * machine, not remote attestation; the scoped bearer token remains the
 * credential.
 */
@Injectable()
export class GatiIngestionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<GatiRequest>();
    const user = req.user;

    // @AllowMachine historically also admitted a head-office user. Legacy
    // ingestion is now machine-only. Destructive routes use @HumansOnly and do
    // not carry this guard, so signed-in operators retain the repair controls.
    if (!user?.isMachine || !user.agentId || user.connectorSourceSystem !== 'gati') {
      throw new ForbiddenException('Legacy Gati ingestion requires an enrolled Gati Connect agent.');
    }

    const profileId = oneHeader(req.headers[GATI_PROFILE_ID_HEADER]);
    const profileHash = oneHeader(req.headers[GATI_PROFILE_HASH_HEADER]);
    const sourceInstanceHash = oneHeader(req.headers[GATI_SOURCE_INSTANCE_HASH_HEADER]);
    const configRevision = oneHeader(req.headers[GATI_CONFIG_REVISION_HEADER]);

    if (
      !profileId ||
      !PROFILE_ID_RE.test(profileId) ||
      !profileHash ||
      !SHA256_RE.test(profileHash) ||
      !sourceInstanceHash ||
      !SHA256_RE.test(sourceInstanceHash) ||
      !configRevision ||
      !CONFIG_REVISION_RE.test(configRevision)
    ) {
      throw new ForbiddenException('Legacy Gati ingestion identity headers are missing or invalid.');
    }

    const agent = await this.prisma.connectAgent.findFirst({
      where: {
        id: user.agentId,
        organisationId: user.organisationId,
        sourceSystem: 'gati',
        revokedAt: null,
      },
      select: {
        config: true,
        sourceInstanceHash: true,
        tokenHash: true,
      },
    });
    if (!agent) {
      throw new ForbiddenException('This Gati Connect agent is not active.');
    }

    const config = jsonObject(agent.config);
    const expectedProfileHash = config.expectedProfileHash;
    const expectedSourceInstanceHash = config.expectedSourceInstanceHash;
    const expectedConfigRevision = config.configRevision ?? '1';

    if (
      config.enabled === false ||
      typeof expectedProfileHash !== 'string' ||
      !SHA256_RE.test(expectedProfileHash) ||
      typeof expectedSourceInstanceHash !== 'string' ||
      !SHA256_RE.test(expectedSourceInstanceHash) ||
      typeof expectedConfigRevision !== 'string' ||
      !CONFIG_REVISION_RE.test(expectedConfigRevision)
    ) {
      throw new ForbiddenException('This Gati Connect agent does not have a complete approved configuration.');
    }

    // Authentication and this post-auth guard are separate awaits. Bind them
    // explicitly so even a token rotation/config replacement in that gap is
    // refused before the source pin or a domain write.
    if (
      !user.agentTokenHash ||
      user.agentTokenHash !== agent.tokenHash ||
      !user.agentConfigRevision ||
      user.agentConfigRevision !== expectedConfigRevision
    ) {
      throw new ForbiddenException('This Gati request was authenticated under an obsolete token or configuration.');
    }

    if (
      profileHash !== expectedProfileHash ||
      sourceInstanceHash !== expectedSourceInstanceHash ||
      configRevision !== expectedConfigRevision
    ) {
      throw new ForbiddenException('Legacy Gati ingestion does not match the current approved configuration.');
    }

    const routing = parseGatiRoutingPolicy(config);
    await this.assertConfiguredStore(user.organisationId, routing.defaultStoreId);

    const bindRequest = () => {
      req.gatiIngestion = Object.freeze({
        agentId: user.agentId!,
        organisationId: user.organisationId,
        tokenHash: user.agentTokenHash!,
        configRevision: user.agentConfigRevision!,
        profileId,
        profileHash,
        sourceInstanceHash,
        routing,
      });
      return true;
    };

    if (agent.sourceInstanceHash === sourceInstanceHash) return bindRequest();
    if (agent.sourceInstanceHash) {
      throw new ForbiddenException('This Gati Connect agent is pinned to a different source descriptor.');
    }

    // Compare-and-set is the first write in the request. If two first-live
    // requests race, only one descriptor can win; the loser re-reads and is
    // refused before any SyncService domain write.
    const pinned = await this.prisma.connectAgent.updateMany({
      where: {
        id: user.agentId,
        organisationId: user.organisationId,
        sourceSystem: 'gati',
        revokedAt: null,
        tokenHash: user.agentTokenHash,
        sourceInstanceHash: null,
        // Keep the first-pin write in the same generation as the guard read.
        // PostgreSQL re-checks these predicates after a competing UPDATE wins
        // the row lock, so stale config cannot pin its source after head office
        // has replaced that config.
        AND: [
          {
            config: {
              path: ['configRevision'],
              equals: expectedConfigRevision,
            },
          },
          {
            config: {
              path: ['expectedProfileHash'],
              equals: profileHash,
            },
          },
          {
            config: {
              path: ['expectedSourceInstanceHash'],
              equals: sourceInstanceHash,
            },
          },
        ],
      },
      data: { sourceInstanceHash },
    });
    if (pinned.count === 1) return bindRequest();

    const winner = await this.prisma.connectAgent.findFirst({
      where: {
        id: user.agentId,
        organisationId: user.organisationId,
        sourceSystem: 'gati',
        revokedAt: null,
      },
      select: { sourceInstanceHash: true },
    });
    if (winner?.sourceInstanceHash !== sourceInstanceHash) {
      throw new ForbiddenException('This Gati Connect agent is pinned to a different source descriptor.');
    }
    return bindRequest();
  }

  private async assertConfiguredStore(organisationId: string, storeId: string | null | undefined): Promise<void> {
    if (!storeId) return;
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, organisationId, isAggregate: false },
      select: { id: true },
    });
    if (!store) {
      throw new ForbiddenException('The approved Gati default store is not available in this organisation.');
    }
  }
}

function oneHeader(value: HeaderValue): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Parse and independently constrain Gati routing. ConnectService validates on
 * the write path; this is the ingestion-side fail-closed copy that prevents a
 * malformed/stale database row from becoming an authorization input.
 */
export function parseGatiRoutingPolicy(config: Record<string, unknown>): GatiRoutingPolicy {
  let defaultStoreId: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(config, 'defaultStoreId')) {
    const value = config.defaultStoreId;
    if (
      value !== null &&
      (typeof value !== 'string' ||
        !value.trim() ||
        value.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(value))
    ) {
      throw new ForbiddenException('The approved Gati defaultStoreId is invalid.');
    }
    defaultStoreId = typeof value === 'string' ? value.trim() : null;
  }

  let unattributedMode: 'holding' | 'default' | undefined;
  if (Object.prototype.hasOwnProperty.call(config, 'unattributedMode')) {
    if (config.unattributedMode !== 'holding' && config.unattributedMode !== 'default') {
      throw new ForbiddenException('The approved Gati unattributedMode is invalid.');
    }
    unattributedMode = config.unattributedMode;
  }
  if (unattributedMode === 'default' && !defaultStoreId) {
    throw new ForbiddenException('The approved Gati default routing mode requires a default store.');
  }

  let branchColumns: GatiRoutingPolicy['branchColumns'];
  if (Object.prototype.hasOwnProperty.call(config, 'branchColumns')) {
    const value = config.branchColumns;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ForbiddenException('The approved Gati branchColumns policy is invalid.');
    }
    const allowed = new Set<string>(GATI_ROUTABLE_ENTITIES);
    const output: Partial<Record<GatiRoutableEntity, readonly string[]>> = {};
    for (const [entity, columns] of Object.entries(value)) {
      if (
        !allowed.has(entity) ||
        !Array.isArray(columns) ||
        columns.length > 8 ||
        columns.some((column) => typeof column !== 'string' || !BRANCH_COLUMN_RE.test(column)) ||
        new Set(columns).size !== columns.length
      ) {
        throw new ForbiddenException('The approved Gati branchColumns policy is invalid.');
      }
      output[entity as GatiRoutableEntity] = Object.freeze([...columns]);
    }
    branchColumns = Object.freeze(output);
  }

  return Object.freeze({
    defaultStoreId,
    unattributedMode,
    branchColumns,
  });
}
