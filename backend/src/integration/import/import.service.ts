import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreScopeService } from '../../common/store-scope.service';
import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/auth-user';
import { MAX_IMPORT_COLUMNS, parseCsv, ParsedTable } from './csv.util';
import { parseXlsx } from './xlsx.util';
import { FIELD_DICTIONARY, ImportEntity, suggestMappings } from './field-dictionary';
import { IMPORTERS } from './entity-importers';
import type { SourceSystem } from '../contracts/provenance';

/**
 * CaratOS import engine (Phase 3/4) — generic Excel/CSV onboarding.
 *
 * Pipeline: DISCOVER → (user maps) → PREVIEW (validate, dry-run) → IMPORT
 * (idempotent, org-scoped, provenance) → RECONCILE. Entity-agnostic: each entity
 * plugs a map+persist into the registry (entity-importers.ts). CSV and XLSX share
 * one pipeline behind {@link ParsedTable}. Organisation ALWAYS comes from the
 * authenticated user; missing data is never fabricated; no row is silently dropped.
 */

export interface FieldMappingInput {
  sourceColumn: string;
  canonicalField: string;
}

interface MachineReceiptMetadata {
  runKey: string;
  profileId: string;
  profileHash: string;
  sourceInstanceHash: string;
  configRevision: string;
  payloadHash: string;
  createdById: string;
  targetStoreId: string | null;
}

interface ResumableMachineReceipt {
  resumeBatchId: string;
  resumeStatus: 'failed' | 'needs_review' | 'running';
}

interface MachineReplayResult {
  batchId: string;
  entity: string;
  sourceSystem: string;
  replayed: true;
  counts: {
    discovered: number;
    imported: number;
    updated: number;
    skipped: number;
    failed: number;
    duplicate: number;
  };
  issues: Array<{ row: number; reason: string }>;
}

interface LockedMachineAgent {
  tokenHash: string;
  revokedAt: Date | null;
  sourceSystem: string;
  sourceInstanceHash: string | null;
  config: Prisma.JsonValue;
}

/**
 * A file can be a plain spreadsheet or an export from a known accounting
 * package. `tally`/`busy` here never imply that their unavailable live adapter
 * ran; they preserve the real origin while using the proven file pipeline.
 */
export type FileImportSourceSystem = Extract<
  SourceSystem,
  'csv' | 'excel' | 'tally' | 'busy' | 'gati' | 'odbc'
>;

const FILE_IMPORT_SOURCES = new Set<FileImportSourceSystem>([
  'csv',
  'excel',
  'tally',
  'busy',
  'gati',
  'odbc',
]);

const SUPPORTED = Object.keys(IMPORTERS) as ImportEntity[];

const MACHINE_ENTITIES: Record<string, ImportEntity[]> = {
  busy: ['customers', 'products'],
  tally: ['customers', 'products'],
  odbc: ['customers', 'stores', 'products'],
  gati: ['customers', 'stores', 'products'],
};

const MACHINE_ID_FIELD: Record<ImportEntity, string> = {
  customers: 'code',
  products: 'sku',
  stores: 'code',
};

const SHA256_RE = /^[a-f0-9]{64}$/;
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9._-]{1,79}$/;
const CONFIG_REVISION_RE = /^[A-Za-z0-9._-]{1,80}$/;
const MACHINE_RUN_STALE_MS = 30 * 60 * 1000;
const MACHINE_LEASE_REFRESH_MS = 60 * 1000;
const MACHINE_LEASE_REFRESH_ROWS = 100;
export const MAX_IMPORT_MAPPING_NAME_CHARACTERS = 256;
export const MAX_IMPORT_REQUEST_SCALAR_CHARACTERS = 128;

function assertEntity(entity: string): asserts entity is ImportEntity {
  if (!SUPPORTED.includes(entity as ImportEntity)) {
    throw new BadRequestException(
      `Unsupported import entity "${entity}". Supported: ${SUPPORTED.join(', ')}.`,
    );
  }
}

/** The actual container format, independently of which system exported it. */
function fileFormat(
  file: { buffer?: Buffer; originalname?: string } | undefined,
): Extract<FileImportSourceSystem, 'csv' | 'excel'> {
  if (!file?.buffer?.length) throw new BadRequestException('No file uploaded');
  const name = (file.originalname ?? '').toLowerCase();
  if (name.endsWith('.xlsx')) return 'excel';
  if (name.endsWith('.csv')) return 'csv';
  if (name.endsWith('.xls')) {
    throw new BadRequestException('Legacy .xls is not supported — re-save as .xlsx or CSV.');
  }
  if (name.endsWith('.pdf') || name.endsWith('.doc') || name.endsWith('.docx')) {
    throw new BadRequestException(
      'PDF and Word files are reference documents, not row-based data. Export the records as CSV/XLSX before importing them.',
    );
  }
  throw new BadRequestException('Unsupported file type. Upload a .csv or .xlsx file.');
}

/** Parse an uploaded file (CSV or XLSX) into a table. */
async function parseFile(
  file: { buffer?: Buffer; originalname?: string } | undefined,
): Promise<ParsedTable> {
  const format = fileFormat(file);
  if (format === 'excel') return parseXlsx(file!.buffer!);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true })
      .decode(file!.buffer!)
      .replace(/^\uFEFF/, '');
  } catch {
    throw new BadRequestException(
      'CSV files must be valid UTF-8. Re-save the file as UTF-8 CSV and try again.',
    );
  }
  return parseCsv(text);
}

function resolveSourceSystem(
  file: { buffer?: Buffer; originalname?: string },
  requested?: string,
): FileImportSourceSystem {
  const format = fileFormat(file);
  if (!requested) return format;
  if (
    typeof requested !== 'string' ||
    requested.length > 32 ||
    /[\u0000-\u001F\u007F]/.test(requested)
  ) {
    throw new BadRequestException('The selected file source is invalid.');
  }
  if (!FILE_IMPORT_SOURCES.has(requested as FileImportSourceSystem)) {
    throw new BadRequestException(
      `Unsupported file source "${requested}". Supported: ${[...FILE_IMPORT_SOURCES].join(', ')}.`,
    );
  }
  if ((requested === 'csv' || requested === 'excel') && requested !== format) {
    throw new BadRequestException(
      `The selected source is ${requested}, but the uploaded file is ${format}.`,
    );
  }
  return requested as FileImportSourceSystem;
}

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
  ) {}

  /** Step 1 — discovery: columns, row count, mapping suggestions, required-field check. */
  async discover(_user: AuthUser, entity: string, file: { buffer?: Buffer; originalname?: string }) {
    assertEntity(entity);
    const { headers, rows } = await parseFile(file);
    if (!headers.length) throw new BadRequestException('The file has no header row');
    const suggestions = suggestMappings(headers, entity);
    const specs = FIELD_DICTIONARY[entity];
    const mapped = new Set(suggestions.map((s) => s.canonicalField).filter(Boolean));
    return {
      entity,
      rowCount: rows.length,
      columns: headers.map((h, i) => ({ name: h, samples: rows.slice(0, 3).map((r) => r[i]).filter((v) => v !== '') })),
      canonicalFields: specs,
      suggestions,
      missingRequired: specs.filter((f) => f.required && !mapped.has(f.field)).map((f) => f.field),
    };
  }

  /** Step 2 — validate every row without business, receipt or control-plane writes. */
  async preview(
    user: AuthUser,
    entity: string,
    file: { buffer?: Buffer; originalname?: string },
    mappings: FieldMappingInput[],
    storeId?: string,
    sourceSystem?: string,
    profileId?: string,
    profileHash?: string,
    sourceInstanceHash?: string,
  ) {
    assertEntity(entity);
    this.resolveStoreId(user, entity, storeId);
    const resolvedSourceSystem = resolveSourceSystem(file, sourceSystem);
    this.assertMachineRequest(user, entity, resolvedSourceSystem, mappings);
    const machineBatchSize = await this.assertMachineProfile(
      user,
      profileId,
      profileHash,
      sourceInstanceHash,
      false,
    );
    const evaluated = await this.evaluate(
      entity,
      file,
      mappings,
      await this.importContext(user, entity, resolvedSourceSystem),
    );
    this.assertMachineRowsHaveIdentity(user, entity, evaluated, sourceInstanceHash);
    this.assertMachineBatchSize(evaluated.length, machineBatchSize);
    return {
      entity,
      total: evaluated.length,
      valid: evaluated.filter((e) => e.result.ok && e.result.warnings.length === 0).length,
      warning: evaluated.filter((e) => e.result.ok && e.result.warnings.length > 0).length,
      error: evaluated.filter((e) => !e.result.ok).length,
      sampleRows: evaluated.slice(0, 20).map((e) => ({
        row: e.rowIndex,
        status: e.result.ok ? (e.result.warnings.length ? 'warning' : 'valid') : 'error',
        value: e.result.value ?? null,
        issues: [...e.result.issues, ...e.result.warnings],
      })),
    };
  }

  /** Step 3 — import: idempotent, org-scoped, provenance-tracked, reconciled. */
  async run(
    user: AuthUser,
    entity: string,
    file: { buffer?: Buffer; originalname?: string },
    mappings: FieldMappingInput[],
    storeId?: string,
    sourceSystem?: string,
    runKey?: string,
    profileId?: string,
    profileHash?: string,
    sourceInstanceHash?: string,
    configRevision?: string,
  ) {
    assertEntity(entity);
    const effectiveStoreId = this.resolveStoreId(user, entity, storeId);
    const org = user.organisationId;
    const importer = IMPORTERS[entity];
    const resolvedSourceSystem = resolveSourceSystem(file, sourceSystem);

    this.assertMachineRequest(user, entity, resolvedSourceSystem, mappings);
    const machineBatchSize = await this.assertMachineProfile(
      user,
      profileId,
      profileHash,
      sourceInstanceHash,
      true,
      configRevision,
    );
    const machineReceipt = this.machineReceiptMetadata(
      user,
      runKey,
      profileId,
      profileHash,
      sourceInstanceHash,
      configRevision,
      file,
      mappings,
      effectiveStoreId,
    );

    let resumableBatch:
      | { resumeBatchId: string; resumeStatus: 'failed' | 'needs_review' | 'running' }
      | undefined;
    if (machineReceipt) {
      const replay = await this.findReceipt(
        org,
        resolvedSourceSystem,
        entity,
        machineReceipt,
      );
      if (replay && 'resumeBatchId' in replay) {
        resumableBatch = replay;
      } else if (replay) {
        return replay;
      }
    }

    const evaluated = await this.evaluate(
      entity,
      file,
      mappings,
      await this.importContext(user, entity, resolvedSourceSystem),
    );
    this.assertMachineRowsHaveIdentity(user, entity, evaluated, sourceInstanceHash);
    this.assertMachineBatchSize(evaluated.length, machineBatchSize);
    this.assertMachineRowsValid(user, evaluated);
    // File parsing/mapping can be expensive. Re-authorize after it so a token
    // rotation, revoke, disable or config replacement that happened while the
    // body was being evaluated cannot reach the first write.
    if (user.isMachine) {
      await this.assertMachineProfile(
        user,
        profileId,
        profileHash,
        sourceInstanceHash,
        true,
        configRevision,
      );
    }
    const counts = { discovered: evaluated.length, imported: 0, updated: 0, skipped: 0, failed: 0, duplicate: 0 };
    const issues: { row: number; reason: string }[] = [];
    const leaseToken = machineReceipt ? randomUUID() : null;
    const leaseStartedAt = new Date();

    // Phase A7 — the batch is opened BEFORE any row is written, so every created
    // row can carry its provenance. Previously the batch was recorded afterwards,
    // which meant imported rows were indistinguishable from hand-entered ones and
    // the go-live purge could not tell them apart.
    //
    // A crash mid-import now leaves a batch stuck in 'running' — which is the
    // honest state, and visible in the import history, rather than no record at
    // all of a half-finished import.
    const openBatch = async (db: Prisma.TransactionClient): Promise<{ id: string }> => {
      if (machineReceipt) {
        const agent = await this.lockAndAssertMachineGeneration(
          db,
          user,
          machineReceipt,
          false,
        );
        if (agent.sourceInstanceHash == null) {
          const pinned = await db.connectAgent.updateMany({
            where: {
              id: user.agentId,
              organisationId: org,
              tokenHash: user.agentTokenHash,
              revokedAt: null,
              sourceInstanceHash: null,
            },
            data: { sourceInstanceHash: machineReceipt.sourceInstanceHash },
          });
          if (pinned.count !== 1) {
            throw new ConflictException(
              'This Connect agent changed or is pinned to a different source connection descriptor.',
            );
          }
        }
      }
      if (resumableBatch) {
        const retryWhere = resumableBatch.resumeStatus !== 'running'
          ? { id: resumableBatch.resumeBatchId, status: resumableBatch.resumeStatus }
          : {
              id: resumableBatch.resumeBatchId,
              status: 'running',
              OR: [
                { leaseExpiresAt: { lt: leaseStartedAt } },
                {
                  leaseExpiresAt: null,
                  updatedAt: { lt: new Date(leaseStartedAt.getTime() - MACHINE_RUN_STALE_MS) },
                },
              ],
            };
        const claimed = await db.importBatch.updateMany({
          where: retryWhere,
          data: {
            status: 'running',
            imported: 0,
            updated: 0,
            skipped: 0,
            failed: 0,
            duplicate: 0,
            leaseToken,
            leaseExpiresAt: new Date(leaseStartedAt.getTime() + MACHINE_RUN_STALE_MS),
          },
        });
        if (claimed.count !== 1) {
          throw new ConflictException('This Connect retry is already being processed.');
        }
        return { id: resumableBatch.resumeBatchId };
      }
      return db.importBatch.create({
        data: {
          organisationId: org,
          sourceSystem: resolvedSourceSystem,
          entity,
          fileName: file.originalname ?? null,
          status: 'running',
          discovered: counts.discovered,
          createdById: user.id,
          runKey: machineReceipt?.runKey ?? null,
          profileId: machineReceipt?.profileId ?? null,
          profileHash: machineReceipt?.profileHash ?? null,
          sourceInstanceHash: machineReceipt?.sourceInstanceHash ?? null,
          configRevision: machineReceipt?.configRevision ?? null,
          payloadHash: machineReceipt?.payloadHash ?? null,
          targetStoreId: effectiveStoreId ?? null,
          leaseToken,
          leaseExpiresAt: leaseToken
            ? new Date(leaseStartedAt.getTime() + MACHINE_RUN_STALE_MS)
            : null,
        },
      });
    };

    let batch: { id: string };
    try {
      batch = machineReceipt
        ? await this.prisma.$transaction(
            (tx) => openBatch(tx),
            { maxWait: 5_000, timeout: 30_000 },
          )
        : await openBatch(this.prisma);
    } catch (error) {
      if (machineReceipt && isUniqueConflict(error)) {
        const replay = await this.findReceipt(
          org,
          resolvedSourceSystem,
          entity,
          machineReceipt,
        );
        if (replay && !('resumeBatchId' in replay)) return replay;
      }
      throw error;
    }

    const closeOwnedMachineReceipt = async (
      error: ForbiddenException | ConflictException,
    ) => {
      if (!machineReceipt || !leaseToken) return;
      await this.prisma.$transaction(async (tx) => {
        // Do not re-authorize an obsolete generation merely to close the
        // receipt it already owns. The lease-token CAS prevents this worker
        // from closing a receipt that a retry has reclaimed.
        const closed = await tx.importBatch.updateMany({
          where: {
            id: batch.id,
            organisationId: org,
            status: 'running',
            leaseToken,
          },
          data: {
            status: 'failed',
            imported: counts.imported,
            updated: counts.updated,
            skipped: counts.skipped,
            failed: counts.failed,
            duplicate: counts.duplicate,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        if (closed.count !== 1) return;
        await this.audit.record(
          user,
          {
            action: 'import.aborted',
            entityType: 'ImportBatch',
            entityId: batch.id,
            storeId: effectiveStoreId,
            summary: `Stopped ${resolvedSourceSystem} ${entity} import after its Connect authorization generation changed`,
            metadata: {
              entity,
              sourceSystem: resolvedSourceSystem,
              agentId: user.agentId,
              runKey: machineReceipt.runKey,
              profileId: machineReceipt.profileId,
              profileHash: machineReceipt.profileHash,
              sourceInstanceHash: machineReceipt.sourceInstanceHash,
              configRevision: machineReceipt.configRevision,
              reason: error.message,
              ...counts,
            },
          },
          tx,
        );
      });
    };

    let fatalMachineError: ForbiddenException | ConflictException | null = null;
    let lastLeaseRefreshAt = leaseStartedAt.getTime();
    for (let rowOffset = 0; rowOffset < evaluated.length; rowOffset++) {
      const e = evaluated[rowOffset];
      const shouldRefreshLease = Boolean(
        leaseToken &&
          rowOffset > 0 &&
          (rowOffset % MACHINE_LEASE_REFRESH_ROWS === 0 ||
            Date.now() - lastLeaseRefreshAt >= MACHINE_LEASE_REFRESH_MS),
      );
      if (!e.result.ok || !e.result.value) {
        counts.failed++;
        issues.push({ row: e.rowIndex, reason: e.result.issues.map((i) => i.message).join('; ') });
        continue;
      }
      try {
        const outcome = await this.prisma.$transaction(
          async (tx) => {
            if (user.isMachine) {
              if (!leaseToken || !configRevision) {
                throw new ForbiddenException('Connect import receipt identity is missing.');
              }
              await this.assertMachinePersistenceFence(
                tx,
                user,
                batch.id,
                leaseToken,
                machineReceipt!,
                shouldRefreshLease,
              );
            }
            // Party and name-only Store identities do not have a database unique
            // constraint. Serialise the matching check + insert on exactly the
            // canonical key the importer uses, across humans and every agent.
            // PostgreSQL releases this advisory lock with the row transaction.
            await this.lockCanonicalImportIdentity(
              tx,
              entity,
              org,
              effectiveStoreId,
              e.result.value!,
            );
            return importer.persist(
              tx,
              org,
              effectiveStoreId,
              e.result.value!,
              batch.id,
            );
          },
          { maxWait: 5_000, timeout: 30_000 },
        );
        if (shouldRefreshLease) lastLeaseRefreshAt = Date.now();
        if (outcome === 'imported') counts.imported++;
        else if (outcome === 'updated') counts.updated++;
        else {
          counts.duplicate++;
          issues.push({ row: e.rowIndex, reason: 'Possible duplicate of an existing record (no unique key to disambiguate)' });
        }
      } catch (err) {
        if (
          user.isMachine &&
          (err instanceof ForbiddenException || err instanceof ConflictException)
        ) {
          fatalMachineError = err;
          break;
        }
        counts.failed++;
        const detail = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Import persistence failed: batch=${batch.id} entity=${entity} row=${e.rowIndex} org=${org}: ${detail}`,
          err instanceof Error ? err.stack : undefined,
        );
        issues.push({
          row: e.rowIndex,
          reason: `Import failed for this row. Contact support with batch ID ${batch.id}.`,
        });
      }
    }

    if (fatalMachineError) {
      await closeOwnedMachineReceipt(fatalMachineError);
      throw fatalMachineError;
    }

    const finalData = {
      status:
        counts.duplicate > 0
          ? 'needs_review'
          : counts.failed > 0
            ? machineReceipt
              ? 'failed'
              : 'needs_review'
            : 'completed',
      imported: counts.imported,
      updated: counts.updated,
      skipped: counts.skipped,
      failed: counts.failed,
      duplicate: counts.duplicate,
      ...(leaseToken ? { leaseToken: null, leaseExpiresAt: null } : {}),
    };
    const auditEvent = {
      action: 'import.run',
      entityType: 'ImportBatch',
      entityId: batch.id,
      storeId: effectiveStoreId,
      summary: `Imported ${entity} from ${resolvedSourceSystem} export ${file.originalname ?? 'file'}: ${counts.imported} new, ${counts.updated} updated, ${counts.duplicate} duplicate, ${counts.failed} failed`,
      metadata: {
        entity,
        sourceSystem: resolvedSourceSystem,
        ...(machineReceipt
          ? {
              agentId: user.agentId,
              runKey: machineReceipt.runKey,
              profileId: machineReceipt.profileId,
              profileHash: machineReceipt.profileHash,
              sourceInstanceHash: machineReceipt.sourceInstanceHash,
              configRevision: machineReceipt.configRevision,
            }
          : {}),
        ...counts,
      },
    };
    if (leaseToken) {
      if (!configRevision) {
        throw new ForbiddenException('Connect import configuration identity is missing.');
      }
      try {
        await this.prisma.$transaction(async (tx) => {
          await this.assertMachinePersistenceFence(
            tx,
            user,
            batch.id,
            leaseToken,
            machineReceipt!,
            false,
          );
          const outcome = await tx.importBatch.updateMany({
            where: { id: batch.id, status: 'running', leaseToken },
            data: finalData,
          });
          if (outcome.count !== 1) {
            throw new ConflictException(
              'This Connect worker lost its receipt lease before finalisation.',
            );
          }
          // A completed machine receipt and its durable agent identity are one
          // security fact. Replays return above and therefore never duplicate it.
          await this.audit.record(user, auditEvent, tx);
        });
      } catch (error) {
        if (error instanceof ForbiddenException || error instanceof ConflictException) {
          await closeOwnedMachineReceipt(error);
        }
        throw error;
      }
    } else {
      await this.prisma.importBatch.update({
        where: { id: batch.id },
        data: finalData,
      });
    }

    // Human uploads retain the historical best-effort audit contract. Machine
    // imports were audited atomically with receipt finalisation above because a
    // ConnectAgent is a first-class durable audit identity, not a User FK.
    if (!user.isMachine) {
      await this.audit.record(user, auditEvent);
    }

    return { batchId: batch.id, entity, sourceSystem: resolvedSourceSystem, counts, issues };
  }

  /**
   * A downloadable CSV template for an entity: the header row a business can fill
   * in. Required fields are suffixed `*`, recommended ones tagged, so the sheet is
   * self-documenting. Returns the raw CSV text.
   */
  template(entity: string): string {
    assertEntity(entity);
    const header = FIELD_DICTIONARY[entity].map((f) =>
      f.required ? `${f.label}*` : f.recommended ? `${f.label} (recommended)` : f.label,
    );
    return header.join(',') + '\n';
  }

  /** GET /imports — recent import batches for the caller's organisation. */
  history(user: AuthUser) {
    return this.prisma.importBatch.findMany({
      where: {
        organisationId: user.organisationId,
        ...(!user.allStores ? { targetStoreId: { in: user.storeIds } } : {}),
      },
      select: {
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
        createdById: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /* ---------------------------------------------------------------- internals */

  private assertMachineRequest(
    user: AuthUser,
    entity: ImportEntity,
    sourceSystem: FileImportSourceSystem,
    mappings: FieldMappingInput[],
  ) {
    if (!user.isMachine) return;
    const allowedEntities = MACHINE_ENTITIES[user.connectorSourceSystem ?? ''];
    if (!allowedEntities) {
      throw new BadRequestException(
        'This machine connector does not use the file-import endpoint.',
      );
    }
    if (sourceSystem !== user.connectorSourceSystem) {
      throw new BadRequestException(
        `This agent is enrolled for ${user.connectorSourceSystem}; it cannot submit ${sourceSystem} data.`,
      );
    }
    if (!allowedEntities.includes(entity)) {
      throw new BadRequestException(
        `${user.connectorSourceSystem} Connect agents may submit only: ${allowedEntities.join(', ')}.`,
      );
    }
    const identityField = MACHINE_ID_FIELD[entity];
    if (!mappings.some((mapping) => mapping?.canonicalField?.trim() === identityField)) {
      throw new BadRequestException(
        `Machine imports for ${entity} must map stable source field "${identityField}".`,
      );
    }
  }

  private async importContext(
    user: AuthUser,
    entity: ImportEntity,
    sourceSystem: string,
  ) {
    const context = {
      sourceSystem,
      isMachine: Boolean(user.isMachine),
      neutralProduct: Boolean(user.isMachine),
    };
    if (entity !== 'products' || user.isMachine) return context;
    const organisation = await this.prisma.organisation.findUnique({
      where: { id: user.organisationId },
      select: { industryPackCode: true },
    });
    return {
      ...context,
      neutralProduct: organisation?.industryPackCode !== 'jewellery',
    };
  }

  private resolveStoreId(
    user: AuthUser,
    entity: ImportEntity,
    requestedStoreId?: string,
  ): string | undefined {
    if (
      requestedStoreId &&
      (typeof requestedStoreId !== 'string' ||
        requestedStoreId.length > MAX_IMPORT_REQUEST_SCALAR_CHARACTERS ||
        /[\u0000-\u001F\u007F]/.test(requestedStoreId))
    ) {
      throw new BadRequestException('The selected store identifier is invalid.');
    }
    if (requestedStoreId) this.scope.assertStoreAllowed(user, requestedStoreId);
    if (entity === 'stores' && !user.allStores) {
      throw new ForbiddenException(
        'A store-scoped principal cannot create or update the organisation store directory.',
      );
    }
    if (requestedStoreId) return requestedStoreId;
    if (!user.allStores) {
      if (user.storeIds.length !== 1) {
        throw new ForbiddenException('Choose one store from your allowed store scope.');
      }
      return user.storeIds[0];
    }
    return undefined;
  }

  private async assertMachineProfile(
    user: AuthUser,
    profileId?: string,
    profileHash?: string,
    sourceInstanceHash?: string,
    requireApprovedProfile = false,
    requestedConfigRevision?: string,
  ): Promise<number | null> {
    if (!user.isMachine) return null;
    if (!profileId || !PROFILE_ID_RE.test(profileId)) {
      throw new BadRequestException('Connect agent profileId is invalid.');
    }
    if (!profileHash || !SHA256_RE.test(profileHash)) {
      throw new BadRequestException('Connect agent profileHash must be a lowercase SHA-256 value.');
    }
    if (!sourceInstanceHash || !SHA256_RE.test(sourceInstanceHash)) {
      throw new BadRequestException(
        'Connect agent sourceInstanceHash must be a lowercase SHA-256 value.',
      );
    }
    if (!user.agentId) throw new ForbiddenException('Connect agent identity is missing.');
    const agent = await this.prisma.connectAgent.findFirst({
      where: { id: user.agentId, organisationId: user.organisationId, revokedAt: null },
      select: {
        config: true,
        sourceInstanceHash: true,
        tokenHash: true,
      },
    });
    if (!agent) throw new ForbiddenException('Connect agent is no longer active.');
    if (!user.agentTokenHash || agent.tokenHash !== user.agentTokenHash) {
      throw new ForbiddenException(
        'This Connect token was rotated after the request was authenticated.',
      );
    }
    const config = agent.config && typeof agent.config === 'object' && !Array.isArray(agent.config)
      ? (agent.config as Record<string, unknown>)
      : {};
    if (config.enabled === false) {
      throw new ForbiddenException('Connect agent is disabled by the server.');
    }
    const expectedProfileHash = typeof config.expectedProfileHash === 'string'
      ? config.expectedProfileHash
      : null;
    if (expectedProfileHash && expectedProfileHash !== profileHash) {
      throw new ConflictException(
        'Local connector profile does not match the server-approved profile hash.',
      );
    }
    if (requireApprovedProfile && expectedProfileHash !== profileHash) {
      throw new ForbiddenException(
        'Live Connect sync requires this exact connector profile hash to be approved by head office.',
      );
    }
    const expectedSourceInstanceHash =
      typeof config.expectedSourceInstanceHash === 'string'
        ? config.expectedSourceInstanceHash
        : null;
    if (
      expectedSourceInstanceHash &&
      expectedSourceInstanceHash !== sourceInstanceHash
    ) {
      throw new ConflictException(
        'Local source descriptor does not match the head-office-approved descriptor hash.',
      );
    }
    if (
      requireApprovedProfile &&
      expectedSourceInstanceHash !== sourceInstanceHash
    ) {
      throw new ForbiddenException(
        'Live Connect sync requires this exact source descriptor hash to be approved by head office.',
      );
    }
    if (agent.sourceInstanceHash && agent.sourceInstanceHash !== sourceInstanceHash) {
      throw new ConflictException(
        'This agent is pinned to a different source connection descriptor. Enrol a separate agent instead of repointing it.',
      );
    }
    if (requireApprovedProfile) {
      const currentConfigRevision =
        typeof config.configRevision === 'string' ? config.configRevision : '1';
      if (!CONFIG_REVISION_RE.test(currentConfigRevision)) {
        throw new ForbiddenException(
          'Connect agent configuration has an invalid server revision; replace it from head office before syncing.',
        );
      }
      if (!requestedConfigRevision || !CONFIG_REVISION_RE.test(requestedConfigRevision)) {
        throw new BadRequestException(
          'Connect agent configRevision is required for a live sync.',
        );
      }
      if (requestedConfigRevision !== currentConfigRevision) {
        throw new ConflictException(
          'Connect agent configuration changed after this run started; reload the server configuration and retry.',
        );
      }
      if (
        !user.agentConfigRevision ||
        user.agentConfigRevision !== currentConfigRevision
      ) {
        throw new ConflictException(
          'Connect agent configuration changed after the request was authenticated.',
        );
      }
    }

    return typeof config.batchSize === 'number' && Number.isInteger(config.batchSize)
      ? Math.min(5000, Math.max(1, config.batchSize))
      : 5000;
  }

  private assertMachineRowsHaveIdentity(
    user: AuthUser,
    entity: ImportEntity,
    evaluated: Array<{
      rowIndex: number;
      result: { ok: boolean; value?: Record<string, unknown> };
    }>,
    sourceInstanceHash?: string,
  ): void {
    if (!user.isMachine) return;
    const identityField = MACHINE_ID_FIELD[entity];
    const source = user.connectorSourceSystem ?? '';
    const expectedPrefix = `${source}:${sourceInstanceHash?.slice(0, 32) ?? ''}:`;
    const seen = new Set<string>();
    let invalid:
      | { rowIndex: number; reason: 'missing' | 'namespace' | 'duplicate' }
      | undefined;
    for (const row of evaluated) {
      if (!row.result.ok) continue;
      const value = row.result.value?.[identityField];
      if (typeof value !== 'string' || !value.trim()) {
        invalid = { rowIndex: row.rowIndex, reason: 'missing' };
        break;
      }
      if (!value.startsWith(expectedPrefix) || value.length === expectedPrefix.length) {
        invalid = { rowIndex: row.rowIndex, reason: 'namespace' };
        break;
      }
      if (seen.has(value)) {
        invalid = { rowIndex: row.rowIndex, reason: 'duplicate' };
        break;
      }
      seen.add(value);
    }
    if (invalid) {
      const reason = invalid.reason === 'missing'
        ? `has no stable source ${identityField}`
        : invalid.reason === 'namespace'
          ? `must use its authenticated ${expectedPrefix} identity namespace`
          : `repeats the same ${identityField} in one payload`;
      throw new BadRequestException(
        `Machine import row ${invalid.rowIndex} ${reason}.`,
      );
    }
  }

  private assertMachineBatchSize(rowCount: number, maximum: number | null): void {
    if (maximum != null && rowCount > maximum) {
      throw new BadRequestException(
        `Connect payload contains ${rowCount} rows; this agent is limited to ${maximum}.`,
      );
    }
  }

  private assertMachineRowsValid(
    user: AuthUser,
    evaluated: Array<{
      rowIndex: number;
      result: { ok: boolean; warnings: Array<unknown> };
    }>,
  ): void {
    if (!user.isMachine) return;
    const invalid = evaluated.filter((row) => !row.result.ok);
    const warned = evaluated.filter(
      (row) => row.result.ok && row.result.warnings.length > 0,
    );
    if (invalid.length || warned.length) {
      throw new BadRequestException(
        `Connect payload has ${invalid.length} invalid and ${warned.length} warning row(s); run preview and correct them before sync.`,
      );
    }
  }

  /**
   * Lock and re-check the exact machine generation accepted by the request edge.
   *
   * A plain read followed by a domain write still leaves a gap in which
   * rotate/configure/revoke can win. `FOR UPDATE` holds the agent row until the
   * surrounding transaction commits, so one protected domain row and the
   * control-plane generation are atomic with respect to each other.
   */
  private async lockAndAssertMachineGeneration(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    receipt: MachineReceiptMetadata,
    requirePinnedSource: boolean,
  ): Promise<LockedMachineAgent> {
    if (
      !user.isMachine ||
      !user.agentId ||
      !user.agentTokenHash ||
      !user.agentConfigRevision
    ) {
      throw new ForbiddenException('Connect request generation identity is missing.');
    }
    const agents = await tx.$queryRaw<LockedMachineAgent[]>(Prisma.sql`
      SELECT
        "tokenHash",
        "revokedAt",
        "sourceSystem",
        "sourceInstanceHash",
        "config"
      FROM "ConnectAgent"
      WHERE "id" = ${user.agentId}
        AND "organisationId" = ${user.organisationId}
      FOR UPDATE
    `);
    const agent = agents[0];
    if (
      !agent ||
      agent.revokedAt ||
      agent.tokenHash !== user.agentTokenHash
    ) {
      throw new ForbiddenException(
        'This Connect token was rotated or revoked while the import was running.',
      );
    }
    if (agent.sourceSystem !== user.connectorSourceSystem) {
      throw new ForbiddenException('Connect agent source identity changed unexpectedly.');
    }

    const config = jsonObject(agent.config);
    const currentRevision =
      typeof config.configRevision === 'string' ? config.configRevision : '1';
    if (
      config.enabled === false ||
      currentRevision !== receipt.configRevision ||
      currentRevision !== user.agentConfigRevision
    ) {
      throw new ConflictException(
        'Connect agent configuration changed while the import was running, or the agent was disabled.',
      );
    }
    if (
      config.expectedProfileHash !== receipt.profileHash ||
      config.expectedSourceInstanceHash !== receipt.sourceInstanceHash
    ) {
      throw new ConflictException(
        'Connect agent profile or source approval changed during the import.',
      );
    }
    if (
      agent.sourceInstanceHash != null &&
      agent.sourceInstanceHash !== receipt.sourceInstanceHash
    ) {
      throw new ConflictException(
        'This Connect agent is pinned to a different source descriptor.',
      );
    }
    if (requirePinnedSource && agent.sourceInstanceHash !== receipt.sourceInstanceHash) {
      throw new ForbiddenException('Connect source binding was lost before persistence.');
    }
    return agent;
  }

  private async assertMachinePersistenceFence(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    batchId: string,
    leaseToken: string,
    receipt: MachineReceiptMetadata,
    refreshLease: boolean,
  ): Promise<void> {
    await this.lockAndAssertMachineGeneration(tx, user, receipt, true);
    // Lock order is always agent then receipt. A stale retry cannot take the
    // lease between this check and the domain write it protects.
    const now = new Date();
    const receipts = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "ImportBatch"
      WHERE "id" = ${batchId}
        AND "organisationId" = ${user.organisationId}
        AND "status" = 'running'
        AND "leaseToken" = ${leaseToken}
        AND "configRevision" = ${receipt.configRevision}
        -- Prisma stores DateTime in this timestamp-without-time-zone column as
        -- a UTC wall-clock value. Normalise the bound timestamptz into that
        -- same domain, or a non-UTC PostgreSQL session shifts the comparison.
        AND "leaseExpiresAt" >= (${now}::timestamptz AT TIME ZONE 'UTC')
      FOR UPDATE
    `);
    if (!receipts[0]) {
      throw new ConflictException(
        'This Connect worker lost its receipt lease; import stopped.',
      );
    }
    if (refreshLease) {
      const refreshed = await tx.importBatch.updateMany({
        where: { id: batchId, status: 'running', leaseToken },
        data: {
          updatedAt: now,
          leaseExpiresAt: new Date(now.getTime() + MACHINE_RUN_STALE_MS),
        },
      });
      if (refreshed.count !== 1) {
        throw new ConflictException(
          'This Connect worker lost its receipt lease; import stopped.',
        );
      }
    }
  }

  /**
   * Transaction-scoped lock for the identity used by each importer lookup.
   *
   * This closes the check-then-create race without imposing a false global
   * uniqueness rule on Party names/phones. The key includes tenant and the same
   * store scope as the lookup; a hash collision only serialises unrelated rows
   * and cannot merge them because the importer still performs its exact query.
   */
  private async lockCanonicalImportIdentity(
    tx: Prisma.TransactionClient,
    entity: ImportEntity,
    organisationId: string,
    storeId: string | undefined,
    value: Record<string, unknown>,
  ): Promise<void> {
    const text = (field: string): string =>
      typeof value[field] === 'string' ? value[field].trim() : '';
    const identity =
      entity === 'customers'
        ? text('code')
          ? ['code', text('code')]
          : text('phone')
            ? ['phone', text('phone')]
            : ['name', text('name')]
        : entity === 'stores'
          ? text('code')
            ? ['code', text('code')]
            : ['name', text('name')]
          : ['sku', text('sku')];
    const scope = entity === 'customers' ? (storeId ?? null) : null;
    const lockKey = JSON.stringify([
      'caratos-import-canonical-v1',
      organisationId,
      entity,
      scope,
      ...identity,
    ]);
    // `pg_advisory_xact_lock` returns PostgreSQL's `void` pseudo-type. Returning
    // that column directly through Prisma makes the query engine try (and fail)
    // to deserialize it. Keep the volatile lock call in a CTE, but project only
    // a normal integer to Prisma; the lock is still held until this transaction
    // commits or rolls back.
    await tx.$queryRaw<Array<{ locked: number }>>(Prisma.sql`
      WITH acquired AS (
        SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
      )
      SELECT 1::int AS "locked" FROM acquired
    `);
  }

  private machineReceiptMetadata(
    user: AuthUser,
    runKey: string | undefined,
    profileId: string | undefined,
    profileHash: string | undefined,
    sourceInstanceHash: string | undefined,
    configRevision: string | undefined,
    file: { buffer?: Buffer },
    mappings: FieldMappingInput[],
    storeId?: string,
  ): MachineReceiptMetadata | null {
    if (!user.isMachine) return null;
    if (!runKey || !SHA256_RE.test(runKey)) {
      throw new BadRequestException('Connect agent runKey must be a lowercase SHA-256 value.');
    }
    if (!profileId || !PROFILE_ID_RE.test(profileId)) {
      throw new BadRequestException('Connect agent profileId is invalid.');
    }
    if (!profileHash || !SHA256_RE.test(profileHash)) {
      throw new BadRequestException('Connect agent profileHash must be a lowercase SHA-256 value.');
    }
    if (!sourceInstanceHash || !SHA256_RE.test(sourceInstanceHash)) {
      throw new BadRequestException(
        'Connect agent sourceInstanceHash must be a lowercase SHA-256 value.',
      );
    }
    if (!configRevision || !CONFIG_REVISION_RE.test(configRevision)) {
      throw new BadRequestException(
        'Connect agent configRevision is required for a live sync.',
      );
    }
    if (!file.buffer?.length) throw new BadRequestException('No file uploaded');
    return {
      runKey,
      profileId,
      profileHash,
      sourceInstanceHash,
      configRevision,
      payloadHash: createHash('sha256')
        .update(file.buffer)
        .update('\0')
        .update(JSON.stringify(mappings))
        .update('\0')
        .update(storeId ?? '')
        .digest('hex'),
      createdById: user.id,
      targetStoreId: storeId ?? null,
    };
  }

  private async findReceipt(
    organisationId: string,
    sourceSystem: string,
    entity: string,
    receipt: MachineReceiptMetadata,
  ): Promise<ResumableMachineReceipt | MachineReplayResult | null> {
    const batch = await this.prisma.importBatch.findFirst({
      where: { organisationId, sourceSystem, entity, runKey: receipt.runKey },
    });
    if (!batch) return null;
    if (
      batch.payloadHash !== receipt.payloadHash ||
      batch.profileId !== receipt.profileId ||
      batch.profileHash !== receipt.profileHash ||
      batch.sourceInstanceHash !== receipt.sourceInstanceHash ||
      batch.configRevision !== receipt.configRevision ||
      (batch.targetStoreId ?? null) !== receipt.targetStoreId ||
      batch.createdById !== receipt.createdById
    ) {
      throw new ConflictException(
        'This Connect runKey was already used for a different agent, profile, mapping or payload; refusing an ambiguous replay.',
      );
    }
    if (batch.status !== 'completed') {
      if (batch.status === 'failed' || batch.status === 'needs_review') {
        return {
          resumeBatchId: batch.id,
          resumeStatus: batch.status as 'failed' | 'needs_review',
        };
      }
      const leaseExpired = batch.leaseExpiresAt instanceof Date
        ? batch.leaseExpiresAt.getTime() < Date.now()
        : batch.updatedAt.getTime() < Date.now() - MACHINE_RUN_STALE_MS;
      if (batch.status === 'running' && leaseExpired) {
        return { resumeBatchId: batch.id, resumeStatus: 'running' as const };
      }
      throw new ConflictException(
        `This Connect run is already ${batch.status}; inspect its receipt before retrying.`,
      );
    }
    return {
      batchId: batch.id,
      entity,
      sourceSystem,
      replayed: true,
      counts: {
        discovered: batch.discovered,
        imported: batch.imported,
        updated: batch.updated,
        skipped: batch.skipped,
        failed: batch.failed,
        duplicate: batch.duplicate,
      },
      issues: [],
    };
  }

  private async evaluate(
    entity: ImportEntity,
    file: { buffer?: Buffer; originalname?: string },
    mappings: FieldMappingInput[],
    context: { sourceSystem: string; isMachine: boolean } = {
      sourceSystem: 'csv',
      isMachine: false,
    },
  ) {
    if (mappings.length > MAX_IMPORT_COLUMNS) {
      throw new BadRequestException(
        `Import mappings may contain at most ${MAX_IMPORT_COLUMNS} entries.`,
      );
    }
    const { headers, rows, rowNumbers } = await parseFile(file);
    const colIndex = new Map(headers.map((h, i) => [h, i] as const));
    const fieldToIndex = new Map<string, number>();
    const seenSources = new Set<string>();
    const allowedFields = new Set(FIELD_DICTIONARY[entity].map((f) => f.field));
    for (const m of mappings) {
      if (
        !m ||
        typeof m.sourceColumn !== 'string' ||
        typeof m.canonicalField !== 'string'
      ) {
        throw new BadRequestException(
          'Every mapping must contain string sourceColumn and canonicalField values.',
        );
      }
      const sourceColumn = m.sourceColumn.trim();
      const canonicalField = m.canonicalField.trim();
      if (
        sourceColumn.length > MAX_IMPORT_MAPPING_NAME_CHARACTERS ||
        canonicalField.length > MAX_IMPORT_MAPPING_NAME_CHARACTERS ||
        /[\u0000-\u001F\u007F]/.test(sourceColumn) ||
        /[\u0000-\u001F\u007F]/.test(canonicalField)
      ) {
        throw new BadRequestException(
          `Mapping names may contain at most ${MAX_IMPORT_MAPPING_NAME_CHARACTERS} characters and no control characters.`,
        );
      }
      if (!canonicalField) continue;
      if (!allowedFields.has(canonicalField)) {
        throw new BadRequestException(`"${canonicalField}" is not a valid field for ${entity}.`);
      }
      const idx = colIndex.get(sourceColumn);
      if (idx == null) {
        throw new BadRequestException(`Mapped column "${sourceColumn}" is not in the file`);
      }
      if (seenSources.has(sourceColumn)) {
        throw new BadRequestException(`Source column "${sourceColumn}" is mapped more than once.`);
      }
      if (fieldToIndex.has(canonicalField)) {
        throw new BadRequestException(
          `CaratOS field "${canonicalField}" is mapped from more than one column.`,
        );
      }
      seenSources.add(sourceColumn);
      fieldToIndex.set(canonicalField, idx);
    }
    const missingRequired = FIELD_DICTIONARY[entity]
      .filter((f) => f.required && !fieldToIndex.has(f.field))
      .map((f) => f.label);
    if (missingRequired.length) {
      throw new BadRequestException(
        `Map the required field${missingRequired.length === 1 ? '' : 's'}: ${missingRequired.join(', ')}.`,
      );
    }
    const importer = IMPORTERS[entity];
    return rows.map((r, i) => {
      const mapped: Record<string, string> = {};
      for (const [field, idx] of fieldToIndex) mapped[field] = r[idx] ?? '';
      return { rowIndex: rowNumbers[i], result: importer.mapRow(mapped, context) };
    });
  }
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
