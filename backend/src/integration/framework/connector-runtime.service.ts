import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/auth-user';
import { ProvenanceService } from '../../common/provenance.service';
import type { FieldMappingInput } from '../import/import.service';
import { ConnectorRegistry } from '../connectors/connector-registry';
import type { SourceSystem } from '../contracts/provenance';
import { sanitizeAgentDiagnostic } from '../connect/connect.service';

/**
 * ConnectorRuntimeService — orchestration, and nothing else (Phase A7/A8).
 *
 * The runtime owns the SHAPE of every data intake:
 *
 *   discover → extract → transform → validate → persist → provenance
 *            → reconcile → sync state / health
 *
 * It owns none of the CONTENT. No vendor parsing, no field mapping, no schema
 * knowledge lives here — those belong to a connector, which is where a mistake
 * about one vendor stays contained to that vendor.
 *
 * WHAT THIS DELIBERATELY IS NOT: a second import engine. `ImportService` already
 * implements the whole file pipeline correctly, including provenance and
 * reconciliation, and this calls it. Re-implementing that here to make the
 * architecture diagram tidier would produce two engines that drift.
 *
 * THE PUSH/PULL DISTINCTION, stated because it is the thing most likely to be got
 * wrong later: the connector contract reads as pull-shaped (`extract()`), but Gati
 * does not work that way. The on-site agent PUSHES batches outbound to CaratOS;
 * CaratOS cannot and must not reach into a customer's network. So the Gati
 * connector reports `pull: false` and its extract path refuses rather than
 * returning an empty array that would look like "no data".
 */

export type IntakeMode = 'pull' | 'push' | 'file_upload';

export type ConnectorRuntimeStatus =
  | 'connected'
  | 'needs_attention'
  | 'failed'
  | 'disabled'
  | 'not_configured';

type RuntimeAgent = {
  sourceSystem: string;
  status: string;
  lastSeenAt: Date | null;
  sourceInstanceHash: string | null;
  config: unknown;
};

type RuntimeState = {
  status: ConnectorRuntimeStatus;
  statusReason: string;
};

const AGENT_STALE_AFTER_MS = 20 * 60 * 1000;
const IMPORT_RECEIPT_STALE_AFTER_MS = 30 * 60 * 1000;
const SHA256_RE = /^[a-f0-9]{64}$/;
const PUBLIC_IMPORT_BATCH_SELECT = {
  id: true,
  targetStoreId: true,
  sourceSystem: true,
  entity: true,
  fileName: true,
  status: true,
  discovered: true,
  imported: true,
  updated: true,
  skipped: true,
  failed: true,
  duplicate: true,
  createdAt: true,
  updatedAt: true,
} as const;

const RUNTIME_IMPORT_BATCH_SELECT = {
  ...PUBLIC_IMPORT_BATCH_SELECT,
  // Selected only to decide whether a machine actually delivered the batch;
  // stripped again before the response leaves this service.
  runKey: true,
  profileId: true,
  profileHash: true,
  sourceInstanceHash: true,
  configRevision: true,
} as const;

type RuntimeImportBatch = Prisma.ImportBatchGetPayload<{
  select: typeof RUNTIME_IMPORT_BATCH_SELECT;
}>;

function publicImportBatch(batch: RuntimeImportBatch) {
  return {
    id: batch.id,
    targetStoreId: batch.targetStoreId,
    sourceSystem: batch.sourceSystem,
    entity: batch.entity,
    fileName: batch.fileName,
    status: batch.status,
    discovered: batch.discovered,
    imported: batch.imported,
    updated: batch.updated,
    skipped: batch.skipped,
    failed: batch.failed,
    duplicate: batch.duplicate,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
  };
}

export interface ConnectorRuntimeDescriptor {
  sourceSystem: SourceSystem;
  name: string;
  description: string;
  status: ConnectorRuntimeStatus;
  /** Why the current tenant-specific status was chosen. */
  statusReason: string;
  /** How data actually gets in. The single most important field here. */
  intakeMode: IntakeMode;
  entities: string[];
  /** Can the runtime start a sync for this source, or does the source start it? */
  runnable: boolean;
  /** Present when `runnable` is false — never left to be inferred. */
  notRunnableReason?: string;
  /**
   * Safe bridge for a source whose direct adapter is unavailable: a user can
   * export CSV/XLSX and retain the source name through the file pipeline.
   */
  fileImportFallback?: {
    sourceSystem: 'tally' | 'busy' | 'gati' | 'odbc';
    acceptedFormats: string[];
    note: string;
  };
}

@Injectable()
export class ConnectorRuntimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectorRegistry,
    private readonly provenance: ProvenanceService,
  ) {}

  /**
   * Every source, with how it actually takes data in. The UI needs `intakeMode`
   * to know whether to offer a "Sync now" button at all — offering one for a
   * push-based source produces a button that can only ever fail.
   */
  async list(user: AuthUser): Promise<ConnectorRuntimeDescriptor[]> {
    const [agents, gatiDeliveryCount] = await Promise.all([
      this.prisma.connectAgent.findMany({
        where: { organisationId: user.organisationId, revokedAt: null },
        select: {
          sourceSystem: true,
          status: true,
          lastSeenAt: true,
          sourceInstanceHash: true,
          config: true,
        },
      }),
      this.prisma.syncState.count({
        where: { organisationId: user.organisationId },
      }),
    ]);
    const stateFor = (sourceSystem: SourceSystem): RuntimeState => {
      if (sourceSystem === 'csv') {
        return {
          status: 'connected',
          statusReason: 'The bounded CSV/XLSX upload path is available.',
        };
      }
      const sourceAgents = agents.filter((agent) => agent.sourceSystem === sourceSystem);
      return resolveRuntimeState(sourceAgents, {
        hasHistoricalDelivery: sourceSystem === 'gati' && gatiDeliveryCount > 0,
      });
    };

    return this.registry.list().map((c) => {
      const state = stateFor(c.sourceSystem);
      if (c.fileUpload) {
        return {
          sourceSystem: c.sourceSystem,
          name: c.name,
          description: c.description,
          ...state,
          intakeMode: 'file_upload' as const,
          entities: c.entities,
          runnable: true,
        };
      }
      if (['gati', 'busy', 'tally', 'odbc'].includes(c.sourceSystem)) {
        const sourceSystem = c.sourceSystem as 'gati' | 'busy' | 'tally' | 'odbc';
        return {
          sourceSystem,
          name: c.name,
          description: c.description,
          ...state,
          intakeMode: 'push' as const,
          entities: c.entities,
          runnable: false,
          notRunnableReason:
            state.status === 'not_configured'
              ? `No ${c.name} Connect agent is enrolled for this organisation.`
              : state.status !== 'connected'
                ? state.statusReason
              : 'The on-site CaratOS Connect agent pushes data outbound to CaratOS on its own ' +
                'schedule. CaratOS never connects into the customer network, so a sync cannot be ' +
                'started from here — run it on the agent machine.',
          fileImportFallback: {
            sourceSystem,
            acceptedFormats: ['.csv', '.xlsx'],
            note:
              `Export ${c.name} master data as CSV/XLSX, confirm the column mapping, ` +
              'preview every row, and import it without losing the source name.',
          },
        };
      }
      return {
        sourceSystem: c.sourceSystem,
        name: c.name,
        description: c.description,
        ...state,
        intakeMode: 'pull' as const,
        entities: c.entities,
        runnable: false,
        notRunnableReason:
          'This connector is not configured. No verified field mapping exists for this source, ' +
          'so no extraction is implemented.',
      };
    });
  }

  /**
   * DISCOVER — what does this source hold, and can we reach it?
   *
   * For a file upload, discovery is per-file and belongs to ImportService. For
   * Gati, discovery is what the agent has already delivered, read from SyncState —
   * which is real information, not a probe of a machine we cannot reach.
   */
  async discover(user: AuthUser, sourceSystem: SourceSystem) {
    const descriptor = this.registry.get(sourceSystem);
    if (!descriptor) throw new BadRequestException(`Unknown source "${sourceSystem}".`);

    if (['busy', 'tally', 'odbc'].includes(sourceSystem)) {
      const [batches, agents, latestMachineReceipt, successfulMachineReceiptCount] = await Promise.all([
        this.prisma.importBatch.findMany({
          where: { organisationId: user.organisationId, sourceSystem },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: RUNTIME_IMPORT_BATCH_SELECT,
        }),
        this.prisma.connectAgent.findMany({
          where: {
            organisationId: user.organisationId,
            sourceSystem,
            revokedAt: null,
          },
          select: {
            id: true,
            name: true,
            sourceSystem: true,
            status: true,
            lastSeenAt: true,
            lastSyncAt: true,
            lastError: true,
            sourceInstanceHash: true,
            config: true,
          },
        }),
        this.prisma.importBatch.findFirst({
          where: {
            organisationId: user.organisationId,
            sourceSystem,
            runKey: { not: null },
            profileId: { not: null },
            profileHash: { not: null },
            sourceInstanceHash: { not: null },
            configRevision: { not: null },
          },
          orderBy: { createdAt: 'desc' },
          select: { status: true, discovered: true },
        }),
        this.prisma.importBatch.count({
          where: {
            organisationId: user.organisationId,
            sourceSystem,
            status: 'completed',
            discovered: { gt: 0 },
            runKey: { not: null },
            profileId: { not: null },
            profileHash: { not: null },
            sourceInstanceHash: { not: null },
            configRevision: { not: null },
          },
        }),
      ]);
      const state = resolveRuntimeState(agents);
      const agentViews = agents.map((agent) => {
        const derived = resolveRuntimeState([agent]);
        return {
          id: agent.id,
          name: agent.name,
          status: derived.status,
          statusReason: derived.statusReason,
          storedStatus: agent.status,
          lastSeenAt: agent.lastSeenAt,
          lastSyncAt: agent.lastSyncAt,
          lastError: sanitizeAgentDiagnostic(agent.lastError),
        };
      });
      // Human CSV/XLSX fallbacks deliberately retain their declared source
      // label. They are useful history, but they are not proof that an on-site
      // agent delivered anything. Only a completed, fully-bound machine
      // receipt can support that claim.
      // Receipt health is queried independently from the bounded recent-history
      // projection. Otherwise ten newer human fallback uploads could erase all
      // evidence of the latest/ever successful machine delivery.
      const everDelivered = successfulMachineReceiptCount > 0;
      const latestReceiptState = runtimeStateForReceipt(latestMachineReceipt);
      const reportedState = combineAgentAndReceiptState(state, latestReceiptState);
      return {
        sourceSystem,
        intakeMode: 'push' as const,
        // Reachability is a property of the agent heartbeat/source approval.
        // Receipt quality is reported separately and must not claim that a
        // healthy machine became unreachable merely because its source was empty.
        reachable: state.status === 'connected',
        ...reportedState,
        // `delivered` remains as the backwards-compatible alias. It describes
        // historical success, never the outcome of the latest receipt.
        delivered: everDelivered,
        everDelivered,
        latestReceiptStatus: latestMachineReceipt?.status ?? null,
        note: describeLatestReceipt(
          descriptor.name,
          latestMachineReceipt,
          everDelivered,
          agents.length > 0,
        ),
        entities: descriptor.entities,
        agents: agentViews,
        recentBatches: batches.map(publicImportBatch),
      };
    }

    if (sourceSystem === 'gati') {
      const [states, provenance, agents] = await Promise.all([
        this.prisma.syncState.findMany({
          where: { organisationId: user.organisationId },
          orderBy: { sourceTable: 'asc' },
        }),
        this.provenance.summary(user.organisationId),
        this.prisma.connectAgent.findMany({
          where: {
            organisationId: user.organisationId,
            sourceSystem,
            revokedAt: null,
          },
          select: {
            sourceSystem: true,
            status: true,
            lastSeenAt: true,
            sourceInstanceHash: true,
            config: true,
          },
        }),
      ]);
      const state = resolveRuntimeState(agents, {
        hasHistoricalDelivery: states.length > 0,
      });
      return {
        sourceSystem,
        intakeMode: 'push' as const,
        reachable: state.status === 'connected',
        delivered: states.length > 0,
        ...state,
        note: states.length
          ? 'The on-site agent has delivered data. Watermarks below are what it has confirmed.'
          : 'No delivery from the on-site agent has been recorded yet for this organisation.',
        // Reported with the source's own column names rather than renamed into
        // generic ones — a watermark that does not match what the agent logs is
        // useless when someone is trying to work out why a sync stalled.
        watermarks: states.map((s) => ({
          sourceTable: s.sourceTable,
          storeId: s.storeId,
          lastLegacyId: s.lastLegacyId,
          lastUpdatedAt: s.lastUpdatedAt,
          lastRunAt: s.lastRunAt,
          rowsSynced: s.rowsSynced,
        })),
        provenance: provenance.counts,
      };
    }

    if (descriptor.fileUpload) {
      const batches = await this.prisma.importBatch.findMany({
        where: { organisationId: user.organisationId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: PUBLIC_IMPORT_BATCH_SELECT,
      });
      return {
        sourceSystem,
        intakeMode: 'file_upload' as const,
        reachable: true,
        note: 'Upload a file to discover its columns. Recent imports are listed below.',
        entities: descriptor.entities,
        recentBatches: batches,
      };
    }

    return {
      sourceSystem,
      intakeMode: 'pull' as const,
      reachable: false,
      note: descriptor.description,
      blocked: true,
      blockedReason:
        'Not configured. No extraction is implemented for this source and no field mapping has been verified.',
    };
  }

  /** Reserved orchestration surface; ImportController is the one live path. */
  async runFileImport(
    _user: AuthUser,
    _input: {
      entity: string;
      file: { buffer?: Buffer; originalname?: string };
      mappings: FieldMappingInput[];
      storeId?: string;
      integrationId?: string;
      sourceSystem?: string;
    },
  ) {
    throw new BadRequestException(
      'Use ImportController for bounded, receipt-tracked file imports.',
    );
  }

  /**
   * Reserved background-import surface. It fails closed until the generic job
   * worker can renew and fence its lease for the full import. The live HTTP
   * endpoint remains bounded by file, row and expanded-XLSX limits.
   */
  async enqueueFileImport(
    _user: AuthUser,
    _input: {
      entity: string;
      file: { buffer?: Buffer; originalname?: string };
      mappings: FieldMappingInput[];
      storeId?: string;
      sourceSystem?: string;
    },
  ) {
    throw new BadRequestException(
      'Background file import is disabled until its worker has a renewable, fenced receipt. Use the bounded synchronous import endpoint.',
    );
  }

  /**
   * RECONCILE — what does CaratOS hold, by origin?
   *
   * Deliberately reports counts by PROVENANCE rather than a source-vs-target diff:
   * a true diff would require reading the customer's system, which for a
   * push-based source CaratOS cannot do. Reporting what is actually knowable is
   * better than a comparison with an invented other side.
   */
  async reconcile(user: AuthUser) {
    const summary = await this.provenance.summary(user.organisationId, [
      'party',
      'product',
      'store',
      'stockItem',
      'sale',
    ]);
    const now = new Date();
    const staleCutoff = new Date(now.getTime() - IMPORT_RECEIPT_STALE_AFTER_MS);
    const finalStatuses = ['completed', 'needs_review', 'failed'];
    const [batches, totalBatches, runningBatches, staleBatches] = await Promise.all([
      this.prisma.importBatch.aggregate({
        where: {
          organisationId: user.organisationId,
          status: { in: finalStatuses },
        },
        _sum: {
          discovered: true,
          imported: true,
          updated: true,
          skipped: true,
          failed: true,
          duplicate: true,
        },
        _count: { _all: true },
      }),
      this.prisma.importBatch.count({
        where: { organisationId: user.organisationId },
      }),
      this.prisma.importBatch.count({
        where: { organisationId: user.organisationId, status: 'running' },
      }),
      this.prisma.importBatch.count({
        where: {
          organisationId: user.organisationId,
          status: 'running',
          OR: [
            { leaseExpiresAt: { lt: now } },
            { leaseExpiresAt: null, updatedAt: { lt: staleCutoff } },
          ],
        },
      }),
    ]);
    const discovered = batches._sum.discovered ?? 0;
    const imported = batches._sum.imported ?? 0;
    const updated = batches._sum.updated ?? 0;
    const skipped = batches._sum.skipped ?? 0;
    const failed = batches._sum.failed ?? 0;
    const duplicate = batches._sum.duplicate ?? 0;
    const accounted = imported + updated + skipped + failed + duplicate;
    const reconciledBatches = batches._count._all;
    return {
      byOrigin: summary.counts,
      imports: {
        // Backward-compatible name: this now means finalized/reconciled batches,
        // not every receipt ever opened. Unfinished work is reported separately.
        batches: reconciledBatches,
        totalBatches,
        inProgressBatches: Math.max(0, runningBatches - staleBatches),
        staleBatches,
        otherUnreconciledBatches: Math.max(
          0,
          totalBatches - reconciledBatches - runningBatches,
        ),
        discovered,
        imported,
        updated,
        skipped,
        failed,
        duplicate,
        accounted,
        unaccounted: discovered - accounted,
        reconciled: discovered === accounted,
      },
      remainingMigration: summary.remainingMigration,
    };
  }
}

function runtimeStateForReceipt(
  receipt: MachineReceiptSummary | null,
): RuntimeState | null {
  if (!receipt) return null;
  if (receipt.status === 'failed') {
    return {
      status: 'failed',
      statusReason:
        'The latest Connect receipt failed. The agent may still be reachable, but its newest sync needs investigation.',
    };
  }
  if (receipt.status === 'running') {
    return {
      status: 'needs_attention',
      statusReason:
        'The latest Connect receipt is still running and has not completed delivery.',
    };
  }
  if (receipt.status === 'needs_review') {
    return {
      status: 'needs_attention',
      statusReason: 'The latest Connect receipt completed with rows that need review.',
    };
  }
  if (receipt.status === 'completed' && receipt.discovered === 0) {
    return {
      status: 'needs_attention',
      statusReason:
        'The latest completed Connect receipt contained zero source rows. Confirm that an empty source was expected.',
    };
  }
  return null;
}

function combineAgentAndReceiptState(
  agent: RuntimeState,
  receipt: RuntimeState | null,
): RuntimeState {
  if (!receipt) return agent;
  // A deliberate control-plane state or absence of an agent is more current
  // than receipt history. A receipt failure still outranks a healthy/stale agent
  // so the latest data outcome cannot be hidden by an older success.
  if (agent.status === 'disabled' || agent.status === 'not_configured') return agent;
  if (agent.status === 'failed') return agent;
  if (receipt.status === 'failed') return receipt;
  if (agent.status === 'needs_attention') return agent;
  return receipt;
}

function describeLatestReceipt(
  connectorName: string,
  receipt: MachineReceiptSummary | null,
  everDelivered: boolean,
  hasAgent: boolean,
): string {
  if (receipt?.status === 'failed') {
    return `The latest ${connectorName} agent receipt failed and needs investigation.`;
  }
  if (receipt?.status === 'running') {
    return `The latest ${connectorName} agent receipt is still running; it is not a completed delivery.`;
  }
  if (receipt?.status === 'needs_review') {
    return `The latest ${connectorName} agent receipt completed with rows that need review.`;
  }
  if (receipt?.status === 'completed' && receipt.discovered === 0) {
    return `The latest ${connectorName} agent receipt was empty and needs review.`;
  }
  if (everDelivered) {
    return `The ${connectorName} agent has delivered master-data batches.`;
  }
  return hasAgent
    ? `${connectorName} is enrolled but has not delivered a master-data batch yet.`
    : `No ${connectorName} Connect agent is enrolled for this organisation.`;
}

type MachineReceiptSummary = Pick<RuntimeImportBatch, 'status' | 'discovered'>;

function resolveRuntimeState(
  agents: RuntimeAgent[],
  options: { hasHistoricalDelivery?: boolean } = {},
): RuntimeState {
  if (!agents.length) {
    if (options.hasHistoricalDelivery) {
      return {
        status: 'needs_attention',
        statusReason:
          'Data has been delivered before, but no enrolled Connect agent can provide current health.',
      };
    }
    return {
      status: 'not_configured',
      statusReason: 'No Connect agent is enrolled for this organisation.',
    };
  }

  const classified = agents.map(classifyAgent);
  if (classified.includes('connected')) {
    return { status: 'connected', statusReason: 'An approved agent checked in recently.' };
  }
  if (classified.includes('error')) {
    return {
      status: 'failed',
      statusReason: 'An enabled Connect agent reported an error on its latest check-in.',
    };
  }
  if (classified.includes('stale')) {
    return {
      status: 'needs_attention',
      statusReason: 'An approved Connect agent is stale and needs attention.',
    };
  }
  if (classified.includes('setup_required')) {
    return {
      status: 'needs_attention',
      statusReason:
        'Setup required: approve both descriptor hashes, complete the source pin, and receive a first healthy check-in.',
    };
  }
  return {
    status: 'disabled',
    statusReason: 'All enrolled Connect agents for this source are disabled.',
  };
}

function classifyAgent(
  agent: RuntimeAgent,
): 'connected' | 'error' | 'stale' | 'setup_required' | 'disabled' {
  const config = jsonObject(agent.config);
  if (config.enabled === false) return 'disabled';
  if (agent.status === 'error') return 'error';

  const expectedProfileHash = config.expectedProfileHash;
  const expectedSourceInstanceHash = config.expectedSourceInstanceHash;
  const approved =
    typeof expectedProfileHash === 'string' &&
    SHA256_RE.test(expectedProfileHash) &&
    typeof expectedSourceInstanceHash === 'string' &&
    SHA256_RE.test(expectedSourceInstanceHash);
  const pinned =
    approved &&
    agent.sourceInstanceHash != null &&
    agent.sourceInstanceHash === expectedSourceInstanceHash;
  if (!approved || !pinned || agent.lastSeenAt == null || agent.status !== 'active') {
    return 'setup_required';
  }
  if (Date.now() - agent.lastSeenAt.getTime() > AGENT_STALE_AFTER_MS) return 'stale';
  return 'connected';
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
