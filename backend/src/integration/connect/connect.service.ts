import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { StoreScopeService } from '../../common/store-scope.service';
import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/auth-user';
import { ConnectorRegistry } from '../connectors/connector-registry';

/**
 * CaratOS Connect — the server side of the on-premise agent (Phase A14).
 *
 * THE DIRECTION OF TRUST IS THE ENTIRE DESIGN. The cloud never opens a
 * connection into a customer's network; the agent dials out. So there is no
 * "connect to client" operation here and there never will be — what this
 * service provides is an IDENTITY the agent presents when it calls in, and a
 * place for it to report what it has been doing.
 *
 * Three rules this enforces, each of which is a way the obvious implementation
 * goes wrong:
 *
 *  1. THE AGENT IS NOT A USER. Authenticating it as a head-office login would
 *     hand a machine in a back office every permission a director has. It gets
 *     its own credential and reaches only its own endpoints.
 *
 *  2. THE ORGANISATION COMES FROM THE TOKEN, NEVER THE REQUEST. An agent never
 *     sends an organisationId. It presents a bearer token; the server looks up
 *     which tenant that token belongs to. A client-supplied tenant is not an
 *     authorization input — that is the same rule the human guard follows.
 *
 *  3. THE TOKEN IS STORED AS A HASH. Only SHA-256 of the token is kept, so a
 *     leaked database dump cannot be replayed as an agent. The plaintext is
 *     shown exactly once, at enrolment, and cannot be recovered afterwards —
 *     losing it means rotating, which is the correct trade.
 */

/** How long without a heartbeat before an agent is reported stale. */
const STALE_AFTER_MS = 20 * 60 * 1000;
const MAX_SYNC_REPORT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_SYNC_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const CONNECT_PROTOCOL_VERSION = 1;
export const CONNECT_MIN_AGENT_VERSION = '0.3.0';
export const CONNECT_MAX_AGENT_VERSION = '0.3.999';

/**
 * Prefix so an agent token is recognisable in a log or a support ticket — and so
 * the auth guard can tell an agent credential from a user JWT before doing any
 * work with it. Exported for that reason.
 */
export const AGENT_TOKEN_PREFIX = 'cxa_';
const TOKEN_PREFIX = AGENT_TOKEN_PREFIX;

@Injectable()
export class ConnectService {
  private readonly log = new Logger(ConnectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
    private readonly registry: ConnectorRegistry,
  ) {}

  /* ------------------------------------------------------ human-facing */

  /**
   * Enrol a new agent and mint its token.
   *
   * The plaintext token is returned HERE AND NOWHERE ELSE. Every later read
   * returns only the prefix, because a credential a support screen can display
   * is a credential that ends up in a screenshot.
   */
  async enrol(
    user: AuthUser,
    input: { name: string; sourceSystem: string; storeId?: string | null },
  ) {
    const descriptor = this.registry.get(input.sourceSystem as never);
    if (!descriptor) {
      throw new BadRequestException(
        `Unknown source "${input.sourceSystem}". Enrol an agent against a connector that exists.`,
      );
    }
    if (!['gati', 'busy', 'tally', 'odbc'].includes(input.sourceSystem)) {
      throw new BadRequestException(
        `${descriptor.name} does not use an on-premise Connect agent.`,
      );
    }
    if (input.storeId) {
      this.scope.assertStoreAllowed(user, input.storeId);
      const store = await this.prisma.store.findFirst({
        where: {
          id: input.storeId,
          organisationId: user.organisationId,
          isAggregate: false,
          isHolding: false,
        },
        select: { id: true },
      });
      if (!store) {
        throw new BadRequestException(
          'A Connect agent can only be assigned to a physical store.',
        );
      }
    }

    const existing = await this.prisma.connectAgent.findFirst({
      where: { organisationId: user.organisationId, name: input.name.trim() },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException(`An agent called "${input.name.trim()}" already exists.`);
    }

    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const agent = await this.prisma.connectAgent.create({
      data: {
        organisationId: user.organisationId,
        name: input.name.trim(),
        storeId: input.storeId ?? null,
        sourceSystem: input.sourceSystem,
        tokenHash: hashToken(token),
        tokenPrefix: token.slice(0, 12),
        status: 'enrolled',
        createdById: user.id,
      },
    });

    await this.audit.record(user, {
      action: 'connect.agent_enrolled',
      entityType: 'ConnectAgent',
      entityId: agent.id,
      storeId: agent.storeId,
      summary: `Enrolled CaratOS Connect agent "${agent.name}" for ${descriptor.name}`,
      metadata: { sourceSystem: agent.sourceSystem },
    });

    return {
      agent: this.toView(agent),
      /** Shown once. There is no endpoint that can return it again. */
      token,
      warning:
        'Copy this token now — it is stored only as a hash and cannot be shown again. If it is lost, rotate the agent.',
    };
  }

  /** Every agent for the caller's organisation, with freshness derived at read time. */
  async list(user: AuthUser) {
    const agents = await this.prisma.connectAgent.findMany({
      where: { organisationId: user.organisationId },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      include: { store: { select: { id: true, name: true } } },
    });
    return agents.map((a) => this.toView(a));
  }

  /**
   * Rotate an agent's token: the old one stops working immediately.
   *
   * Rotation rather than "show me the token again", because the second thing is
   * impossible by construction and pretending otherwise would require storing
   * the secret.
   */
  async rotate(user: AuthUser, agentId: string) {
    const agent = await this.requireAgent(user, agentId);
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const updated = await this.prisma.connectAgent.update({
      where: { id: agent.id },
      data: {
        tokenHash: hashToken(token),
        tokenPrefix: token.slice(0, 12),
        revokedAt: null,
        revokedById: null,
        status: 'enrolled',
        // A heartbeat belongs to the credential that produced it. Keeping its
        // timestamp across rotation makes the replacement token look checked-in
        // before it has ever proved possession.
        lastSeenAt: null,
        lastError: null,
      },
    });
    await this.audit.record(user, {
      action: 'connect.agent_rotated',
      entityType: 'ConnectAgent',
      entityId: agent.id,
      summary: `Rotated the token for agent "${agent.name}" — the previous token no longer works`,
    });
    return { agent: this.toView(updated), token };
  }

  /** Revoke an agent. The row is kept so its history stays readable. */
  async revoke(user: AuthUser, agentId: string) {
    const agent = await this.requireAgent(user, agentId);
    const updated = await this.prisma.connectAgent.update({
      where: { id: agent.id },
      data: { revokedAt: new Date(), revokedById: user.id, status: 'revoked' },
    });
    await this.audit.record(user, {
      action: 'connect.agent_revoked',
      entityType: 'ConnectAgent',
      entityId: agent.id,
      summary: `Revoked CaratOS Connect agent "${agent.name}"`,
    });
    return this.toView(updated);
  }

  /**
   * Set the non-secret configuration the agent will collect on its next
   * heartbeat: which tables, batch size, schedule.
   *
   * Secrets never travel this way. The agent's own source credentials (the SQL
   * Server login it reads with) stay on the customer's machine — the cloud has
   * no business holding a credential to a network it cannot reach.
   */
  async configure(user: AuthUser, agentId: string, config: Record<string, unknown>) {
    const agent = await this.requireAgent(user, agentId);
    const validated = validateAgentConfig(config);
    const expectedSourceInstanceHash = validated.expectedSourceInstanceHash;
    if (agent.sourceInstanceHash) {
      if (
        expectedSourceInstanceHash !== undefined &&
        expectedSourceInstanceHash !== agent.sourceInstanceHash
      ) {
        throw new BadRequestException(
          'config.expectedSourceInstanceHash conflicts with the source identity already pinned to this agent.',
        );
      }
      // Configuration replacement is a whole-document write. Preserve an
      // immutable source pin when callers update only schedule/routing fields;
      // otherwise omission (or an explicit null) would make neither the old nor
      // a new source generation admissible.
      validated.expectedSourceInstanceHash = agent.sourceInstanceHash;
    }
    const hasGatiRoutingPolicy = GATI_ROUTING_CONFIG_KEYS.some((key) => key in validated);
    if (hasGatiRoutingPolicy && agent.sourceSystem !== 'gati') {
      throw new BadRequestException(
        'defaultStoreId, unattributedMode and branchColumns are supported only for Gati agents.',
      );
    }
    if (typeof validated.defaultStoreId === 'string') {
      const store = await this.prisma.store.findFirst({
        where: {
          id: validated.defaultStoreId,
          organisationId: user.organisationId,
          isAggregate: false,
          isHolding: false,
          attendanceOnly: false,
          status: { not: 'closed' },
        },
        select: { id: true },
      });
      if (!store) {
        throw new BadRequestException(
          'config.defaultStoreId must identify a physical store in this organisation.',
        );
      }
    }
    if (
      validated.unattributedMode === 'default' &&
      typeof validated.defaultStoreId !== 'string'
    ) {
      throw new BadRequestException(
        'config.defaultStoreId is required when config.unattributedMode is "default".',
      );
    }
    const safeConfig: Record<string, unknown> = {
      ...validated,
      // An opaque server generation, deliberately replaced even when the
      // effective settings are identical. The agent must echo this on a live
      // import, which prevents a delayed worker from committing under a config
      // that head office has already replaced.
      configRevision: randomUUID(),
    };
    let updated;
    try {
      updated = await this.prisma.connectAgent.update({
        where: {
          id: agent.id,
          organisationId: user.organisationId,
          // The first live import pins this field under a row lock. Keep this
          // predicate on the UPDATE as well as the friendly pre-check above, so
          // a pin that wins between requireAgent() and this write cannot be
          // followed by a contradictory approved configuration.
          ...(typeof safeConfig.expectedSourceInstanceHash === 'string'
            ? {
                OR: [
                  { sourceInstanceHash: null },
                  { sourceInstanceHash: safeConfig.expectedSourceInstanceHash },
                ],
              }
            : { sourceInstanceHash: agent.sourceInstanceHash ?? null }),
        },
        // A changed config/revision needs a new-token/config heartbeat before the
        // admin view may call this agent active again.
        data: { config: safeConfig as Prisma.InputJsonValue, status: 'enrolled' },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new BadRequestException(
          'config.expectedSourceInstanceHash conflicts with the source identity already pinned to this agent.',
        );
      }
      throw error;
    }
    await this.audit.record(user, {
      action: 'connect.agent_configured',
      entityType: 'ConnectAgent',
      entityId: agent.id,
      summary: `Updated configuration for agent "${agent.name}"`,
    });
    return this.toView(updated);
  }

  /* ------------------------------------------------------ agent-facing */

  /**
   * Resolve a presented bearer token to an agent.
   *
   * The lookup is by hash, which is an indexed equality search — no scan, and no
   * opportunity to leak timing information about which tokens exist. The extra
   * constant-time compare guards the (impossible-in-practice) hash collision and
   * costs nothing.
   *
   * A revoked agent authenticates nowhere: the check is here rather than in each
   * endpoint so it cannot be forgotten by a new one.
   */
  async authenticate(rawToken: string | undefined) {
    if (!rawToken?.startsWith(TOKEN_PREFIX)) {
      throw new UnauthorizedException('A CaratOS Connect agent token is required.');
    }
    const hash = hashToken(rawToken);
    const agent = await this.prisma.connectAgent.findUnique({ where: { tokenHash: hash } });
    if (!agent || !safeEqualHex(agent.tokenHash, hash)) {
      throw new UnauthorizedException('This agent token is not recognised.');
    }
    if (agent.revokedAt) {
      throw new ForbiddenException('This agent has been revoked. Enrol it again to reconnect.');
    }
    return agent;
  }

  /**
   * The agent checks in: reports what it is, gets told what to do.
   *
   * Note what is NOT accepted here — an organisation id. The tenant is whatever
   * the token says it is. `agentVersion`, `hostname` and `os` ARE accepted but
   * are display-only: they are self-reported by a machine we do not control, so
   * nothing is ever authorized on their basis.
   */
  async heartbeat(
    agentId: string,
    rawToken: string | undefined,
    input: {
      agentVersion?: string;
      hostname?: string;
      os?: string;
      status?: 'active' | 'error';
      error?: string | null;
      stats?: Record<string, unknown>;
      syncedAt?: string;
    },
  ) {
    if (!rawToken?.startsWith(TOKEN_PREFIX)) {
      throw new UnauthorizedException('A CaratOS Connect agent token is required.');
    }
    const presentedTokenHash = hashToken(rawToken);
    const now = new Date();
    const syncedAt = validateSyncedAt(input, now);
    const updated = await this.prisma.connectAgent.updateMany({
      // Authentication and this write are separate statements. Re-check both
      // revocation and the exact presented token here so a concurrent revoke or
      // rotation cannot be followed by a stale request marking the agent active.
      where: {
        id: agentId,
        tokenHash: presentedTokenHash,
        revokedAt: null,
        // The timestamp is captured as the request enters the service. If this
        // request stalls while a later heartbeat commits, its older diagnostic
        // payload must not restore stale status/error/stats afterwards. Strict
        // `lt` also gives equal-millisecond requests one deterministic winner.
        AND: [
          {
            OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: now } }],
          },
        ],
        ...(syncedAt
          ? { OR: [{ lastSyncAt: null }, { lastSyncAt: { lte: syncedAt } }] }
          : {}),
      },
      data: {
        lastSeenAt: now,
        agentVersion: input.agentVersion?.slice(0, 40) ?? undefined,
        hostname: input.hostname?.slice(0, 120) ?? undefined,
        os: input.os?.slice(0, 120) ?? undefined,
        status: input.status === 'error' ? 'error' : 'active',
        // An error is CLEARED on a healthy beat, so a transient failure does not
        // leave a permanent red mark that nobody can dismiss.
        lastError:
          input.status === 'error'
            ? sanitizeAgentDiagnostic(input.error ?? 'The agent reported an error.')
            : null,
        ...(input.stats
          ? { lastStats: sanitizeAgentStats(input.stats) as Prisma.InputJsonValue }
          : {}),
        ...(syncedAt ? { lastSyncAt: syncedAt } : {}),
      },
    });
    if (updated.count !== 1) {
      if (syncedAt) {
        const current = await this.prisma.connectAgent.findUnique({
          where: { id: agentId },
          select: { tokenHash: true, revokedAt: true, lastSyncAt: true },
        });
        if (
          current &&
          !current.revokedAt &&
          safeEqualHex(current.tokenHash, presentedTokenHash) &&
          current.lastSyncAt &&
          current.lastSyncAt.getTime() > syncedAt.getTime()
        ) {
          throw new BadRequestException(
            'syncedAt is older than the last successful sync already recorded.',
          );
        }
      }
      throw new ForbiddenException(
        'This agent token changed or was revoked before the heartbeat completed.',
      );
    }
    const agent = await this.prisma.connectAgent.findUnique({
      where: { id: agentId },
      include: { store: { select: { id: true, name: true } } },
    });
    // A rotation can also win immediately after the conditional write. Its
    // status='enrolled' update is authoritative; refuse the stale response.
    if (
      !agent ||
      agent.revokedAt ||
      !safeEqualHex(agent.tokenHash, presentedTokenHash)
    ) {
      throw new ForbiddenException(
        'This agent token changed or was revoked before the heartbeat completed.',
      );
    }

    return {
      acknowledged: true,
      /** What the server wants done. The agent asks; the server decides. */
      ...agentPolicy(agent.config),
      sourceSystem: agent.sourceSystem,
      storeId: agent.storeId,
      /** Next check-in, so the agent does not have to hardcode a schedule. */
      heartbeatSeconds: 300,
      serverTime: now.toISOString(),
    };
  }

  /** Protocol/config view used by GET /me before an agent opens its source. */
  identity(agent: {
    id: string;
    name: string;
    sourceSystem: string;
    storeId: string | null;
    organisationId: string;
    sourceInstanceHash: string | null;
    config: Prisma.JsonValue;
  }) {
    return {
      agentId: agent.id,
      name: agent.name,
      sourceSystem: agent.sourceSystem,
      storeId: agent.storeId,
      organisationId: agent.organisationId,
      sourceInstanceHash: agent.sourceInstanceHash,
      ...agentPolicy(agent.config),
    };
  }

  /* ------------------------------------------------------------ shared */

  private async requireAgent(user: AuthUser, agentId: string) {
    const agent = await this.prisma.connectAgent.findFirst({
      where: { id: agentId, organisationId: user.organisationId },
    });
    if (!agent) throw new NotFoundException('Agent not found in your organisation.');
    return agent;
  }

  /**
   * `status` is DERIVED at read time, not stored as a fact.
   *
   * A stored "stale" would need a timer to write it, and the moment that timer
   * fell behind the badge would contradict the timestamp printed next to it.
   * Computing it from `lastSeenAt` makes the two incapable of disagreeing.
   */
  private toView(agent: {
    id: string;
    name: string;
    sourceSystem: string;
    storeId: string | null;
    store?: { id: string; name: string } | null;
    status: string;
    tokenPrefix: string;
    agentVersion: string | null;
    hostname: string | null;
    os: string | null;
    lastSeenAt: Date | null;
    lastSyncAt: Date | null;
    lastError: string | null;
    lastStats: Prisma.JsonValue;
    config: Prisma.JsonValue;
    revokedAt: Date | null;
    createdAt: Date;
  }) {
    const policy = agentPolicy(agent.config);
    const stale =
      !agent.revokedAt &&
      agent.lastSeenAt != null &&
      Date.now() - agent.lastSeenAt.getTime() > STALE_AFTER_MS;
    const derived = agent.revokedAt
      ? 'revoked'
      : !policy.enabled
        ? 'disabled'
        : agent.status === 'enrolled' || agent.lastSeenAt == null
        ? 'enrolled'
        : agent.status === 'error'
          ? 'error'
          : stale
            ? 'stale'
            : 'active';

    return {
      id: agent.id,
      name: agent.name,
      sourceSystem: agent.sourceSystem,
      storeId: agent.storeId,
      store: agent.store ?? null,
      status: derived,
      statusReason: describeStatus(
        derived,
        agent.lastSeenAt,
        sanitizeAgentDiagnostic(agent.lastError),
      ),
      /** Only the prefix. The token itself is unrecoverable by design. */
      tokenPrefix: agent.tokenPrefix,
      agentVersion: agent.agentVersion,
      hostname: agent.hostname,
      os: agent.os,
      lastSeenAt: agent.lastSeenAt,
      lastSyncAt: agent.lastSyncAt,
      // Re-sanitize on every read as well as on heartbeat. Older rows and
      // operational repairs may pre-date the current ingestion boundary.
      lastError: sanitizeAgentDiagnostic(agent.lastError),
      lastStats: agent.lastStats,
      // Never project arbitrary stored JSON. `agentPolicy` is also the parser
      // used for /me and heartbeat, so human and machine views cannot disagree
      // about which non-secret keys belong to the Connect protocol.
      config: policy.config,
      revokedAt: agent.revokedAt,
      createdAt: agent.createdAt,
    };
  }
}

const AGENT_CONFIG_KEYS = new Set([
  'enabled',
  'expectedProfileHash',
  'expectedSourceInstanceHash',
  'configRevision',
  'syncIntervalMinutes',
  'batchSize',
  'defaultStoreId',
  'unattributedMode',
  'branchColumns',
]);

const GATI_ROUTING_CONFIG_KEYS = [
  'defaultStoreId',
  'unattributedMode',
  'branchColumns',
] as const;

const GATI_BRANCH_ENTITIES = new Set([
  'parties',
  'products',
  'stock',
  'sales',
  'orders',
  'ledger',
]);
const MAX_BRANCH_COLUMNS_PER_ENTITY = 8;
const MAX_BRANCH_COLUMN_CHARACTERS = 80;
const GATI_BRANCH_COLUMN_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

const AGENT_STAT_KEYS = new Set([
  'profile',
  'profileHash',
  'sourceInstanceHash',
  'phase',
  'entity',
  'entitiesChecked',
  'entitiesChanged',
  'rowsRead',
  'rowsFiltered',
  'rowsReady',
  'rowsRejectedLocally',
  'rowsServerValid',
  'rowsServerWarning',
  'rowsServerError',
  'rowsImported',
  'rowsUpdated',
  'rowsDuplicate',
  'rowsFailed',
  'dryRun',
  'disabled',
]);

function validateAgentConfig(input: Record<string, unknown>): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('config must be an object.');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'configRevision')) {
    throw new BadRequestException(
      'config.configRevision is server-controlled and cannot be supplied.',
    );
  }
  const unknown = Object.keys(input).filter((key) => !AGENT_CONFIG_KEYS.has(key));
  if (unknown.length) {
    throw new BadRequestException(
      `Unsupported agent config keys: ${unknown.join(', ')}. Secrets must remain on the client machine.`,
    );
  }
  const output: Record<string, unknown> = {};
  if ('enabled' in input) {
    if (typeof input.enabled !== 'boolean') throw new BadRequestException('config.enabled must be boolean.');
    output.enabled = input.enabled;
  }
  if ('expectedProfileHash' in input) {
    if (
      input.expectedProfileHash !== null &&
      (typeof input.expectedProfileHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedProfileHash))
    ) {
      throw new BadRequestException('config.expectedProfileHash must be null or lowercase SHA-256.');
    }
    output.expectedProfileHash = input.expectedProfileHash;
  }
  if ('expectedSourceInstanceHash' in input) {
    if (
      input.expectedSourceInstanceHash !== null &&
      (typeof input.expectedSourceInstanceHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(input.expectedSourceInstanceHash))
    ) {
      throw new BadRequestException(
        'config.expectedSourceInstanceHash must be null or lowercase SHA-256.',
      );
    }
    output.expectedSourceInstanceHash = input.expectedSourceInstanceHash;
  }
  for (const [key, minimum, maximum] of [
    ['syncIntervalMinutes', 5, 1440],
    ['batchSize', 1, 5000],
  ] as const) {
    if (key in input) {
      const value = input[key];
      if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
        throw new BadRequestException(`config.${key} must be an integer from ${minimum} to ${maximum}.`);
      }
      output[key] = value;
    }
  }
  if ('defaultStoreId' in input) {
    if (
      input.defaultStoreId !== null &&
      (typeof input.defaultStoreId !== 'string' ||
        !input.defaultStoreId.trim() ||
        input.defaultStoreId.length > 128 ||
        /[\u0000-\u001F\u007F]/.test(input.defaultStoreId))
    ) {
      throw new BadRequestException(
        'config.defaultStoreId must be null or a store id of at most 128 characters.',
      );
    }
    output.defaultStoreId =
      typeof input.defaultStoreId === 'string' ? input.defaultStoreId.trim() : null;
  }
  if ('unattributedMode' in input) {
    if (input.unattributedMode !== 'holding' && input.unattributedMode !== 'default') {
      throw new BadRequestException(
        'config.unattributedMode must be either "holding" or "default".',
      );
    }
    output.unattributedMode = input.unattributedMode;
  }
  if ('branchColumns' in input) {
    if (
      !input.branchColumns ||
      typeof input.branchColumns !== 'object' ||
      Array.isArray(input.branchColumns)
    ) {
      throw new BadRequestException('config.branchColumns must be an object.');
    }
    const entries = Object.entries(input.branchColumns as Record<string, unknown>);
    const unsupported = entries
      .map(([entity]) => entity)
      .filter((entity) => !GATI_BRANCH_ENTITIES.has(entity));
    if (unsupported.length) {
      throw new BadRequestException(
        `config.branchColumns has unsupported entities: ${unsupported.join(', ')}.`,
      );
    }
    const branchColumns: Record<string, string[]> = {};
    for (const [entity, rawColumns] of entries) {
      if (!Array.isArray(rawColumns) || rawColumns.length > MAX_BRANCH_COLUMNS_PER_ENTITY) {
        throw new BadRequestException(
          `config.branchColumns.${entity} must contain at most ${MAX_BRANCH_COLUMNS_PER_ENTITY} column names.`,
        );
      }
      const columns = rawColumns.map((column) => {
        if (
          typeof column !== 'string' ||
          column.length > MAX_BRANCH_COLUMN_CHARACTERS ||
          !GATI_BRANCH_COLUMN_RE.test(column)
        ) {
          throw new BadRequestException(
            `config.branchColumns.${entity} contains an invalid column name.`,
          );
        }
        return column;
      });
      if (new Set(columns).size !== columns.length) {
        throw new BadRequestException(
          `config.branchColumns.${entity} must not repeat a column name.`,
        );
      }
      branchColumns[entity] = columns;
    }
    output.branchColumns = branchColumns;
  }
  return output;
}

function agentPolicy(value: Prisma.JsonValue) {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const config: Record<string, unknown> = Object.fromEntries(
    Object.entries(raw).filter(([key]) => AGENT_CONFIG_KEYS.has(key)),
  );
  const defaultStoreId = isStoredStoreId(raw.defaultStoreId)
    ? raw.defaultStoreId
    : null;
  const unattributedMode =
    raw.unattributedMode === 'default' ? 'default' as const : 'holding' as const;
  const branchColumns = sanitizeStoredBranchColumns(raw.branchColumns);
  if ('defaultStoreId' in config) config.defaultStoreId = defaultStoreId;
  if ('unattributedMode' in config) config.unattributedMode = unattributedMode;
  if ('branchColumns' in config) config.branchColumns = branchColumns;
  return {
    config,
    enabled: raw.enabled !== false,
    expectedProfileHash:
      typeof raw.expectedProfileHash === 'string' ? raw.expectedProfileHash : null,
    expectedSourceInstanceHash:
      typeof raw.expectedSourceInstanceHash === 'string'
        ? raw.expectedSourceInstanceHash
        : null,
    configRevision:
      typeof raw.configRevision === 'string' ? raw.configRevision : '1',
    syncIntervalMinutes:
      typeof raw.syncIntervalMinutes === 'number' ? raw.syncIntervalMinutes : 15,
    batchSize: typeof raw.batchSize === 'number' ? raw.batchSize : 5000,
    defaultStoreId,
    unattributedMode,
    branchColumns,
    protocolVersion: CONNECT_PROTOCOL_VERSION,
    minimumAgentVersion: CONNECT_MIN_AGENT_VERSION,
    maximumAgentVersion: CONNECT_MAX_AGENT_VERSION,
  };
}

function isStoredStoreId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Boolean(value.trim()) &&
    value.length <= 128 &&
    !/[\u0000-\u001F\u007F]/.test(value)
  );
}

function sanitizeStoredBranchColumns(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: Record<string, string[]> = {};
  for (const [entity, rawColumns] of Object.entries(value)) {
    if (
      !GATI_BRANCH_ENTITIES.has(entity) ||
      !Array.isArray(rawColumns) ||
      rawColumns.length > MAX_BRANCH_COLUMNS_PER_ENTITY ||
      rawColumns.some(
        (column) =>
          typeof column !== 'string' ||
          column.length > MAX_BRANCH_COLUMN_CHARACTERS ||
          !GATI_BRANCH_COLUMN_RE.test(column),
      ) ||
      new Set(rawColumns).size !== rawColumns.length
    ) {
      continue;
    }
    output[entity] = rawColumns as string[];
  }
  return output;
}

function validateSyncedAt(
  input: { status?: 'active' | 'error'; error?: string | null; syncedAt?: string },
  now: Date,
): Date | null {
  if (input.syncedAt == null) return null;
  if (input.status !== 'active' || (typeof input.error === 'string' && input.error.trim())) {
    throw new BadRequestException(
      'syncedAt is accepted only with an explicit healthy status="active" heartbeat.',
    );
  }
  if (
    typeof input.syncedAt !== 'string' ||
    input.syncedAt.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input.syncedAt)
  ) {
    throw new BadRequestException('syncedAt must be a UTC RFC 3339 timestamp.');
  }
  const parsed = new Date(input.syncedAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException('syncedAt must be a valid timestamp.');
  }
  if (parsed.getTime() > now.getTime() + MAX_SYNC_FUTURE_SKEW_MS) {
    throw new BadRequestException('syncedAt is too far in the future.');
  }
  if (parsed.getTime() < now.getTime() - MAX_SYNC_REPORT_AGE_MS) {
    throw new BadRequestException('syncedAt is too old to describe this heartbeat.');
  }
  return parsed;
}

function sanitizeAgentStats(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!AGENT_STAT_KEYS.has(key)) continue;
    if (typeof value === 'boolean') output[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000) {
      output[key] = Math.trunc(value);
    } else if (typeof value === 'string' && value.length <= 100) {
      output[key] = value;
    }
  }
  return output;
}

const SENSITIVE_DIAGNOSTIC_KEY =
  '(?:pwd|password|passphrase|token|authorization|user[\\s_-]*id|uid|client[\\s_-]*secret|consumer[\\s_-]*secret|api[\\s_-]*key|access[\\s_-]*key|secret[\\s_-]*key|private[\\s_-]*key|ssl[\\s_-]*key|(?:access|refresh|id|auth)[\\s_-]*token|connection[\\s_-]*string)';
const SENSITIVE_DIAGNOSTIC_VALUE =
  '(?:"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|\\{[^}\\r\\n]*\\}|\\[[^\\]\\r\\n]*\\]|[^;\\r\\n]+)';
const SENSITIVE_DIAGNOSTIC_ASSIGNMENT = new RegExp(
  `(["']?\\b${SENSITIVE_DIAGNOSTIC_KEY}\\b["']?\\s*(?:=|:)\\s*)${SENSITIVE_DIAGNOSTIC_VALUE}`,
  'gi',
);
const SENSITIVE_DIAGNOSTIC_SPACED_VALUE = new RegExp(
  `(\\b${SENSITIVE_DIAGNOSTIC_KEY}\\b\\s+)${SENSITIVE_DIAGNOSTIC_VALUE}`,
  'gi',
);
const PEM_PRIVATE_KEY =
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi;

/**
 * Preserve a bounded operational hint without turning agent-controlled error
 * text into a credential projection. This runs both before persistence and at
 * every human-facing read boundary so legacy rows receive the same protection.
 */
export function sanitizeAgentDiagnostic(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value
    .replace(PEM_PRIVATE_KEY, '[REDACTED PRIVATE KEY]')
    .replace(SENSITIVE_DIAGNOSTIC_ASSIGNMENT, '$1[REDACTED]')
    .replace(SENSITIVE_DIAGNOSTIC_SPACED_VALUE, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\b(?:bearer|basic)\s+(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, (match) =>
      `${match.slice(0, match.search(/\s/))} [REDACTED]`,
    )
    .replace(/\bcxa_[a-z0-9_-]+\b/gi, '[REDACTED CONNECT TOKEN]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .slice(0, 2000);
}

/** A sentence a UI can render verbatim, so the badge never needs interpreting. */
function describeStatus(status: string, lastSeenAt: Date | null, lastError: string | null): string {
  switch (status) {
    case 'revoked':
      return 'Revoked. This agent can no longer send data.';
    case 'disabled':
      return 'Disabled by head office. This agent cannot send data until it is enabled again.';
    case 'enrolled':
      return 'Waiting for a successful check-in with the current token and approved configuration.';
    case 'error':
      return lastError ?? 'The agent reported an error on its last check-in.';
    case 'stale':
      return `No check-in since ${lastSeenAt?.toISOString() ?? 'unknown'}. The machine may be off, or the agent stopped.`;
    default:
      return 'Checking in normally.';
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time compare for two hex digests of equal length. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
