import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { DEFAULT_PAGE_SIZE, parsePagination } from '../common/pagination';

/** Parsed query params for the audit-log read endpoint. */
export interface AuditQuery {
  entityType?: string;
  entityId?: string;
  action?: string;
  from?: string;
  to?: string;
  /** Explicit store filter (an in-page dropdown); validated against the caller's scope. */
  storeId?: string;
  page?: string;
  pageSize?: string;
}

/** Parse a date-bound query param; returns undefined for missing/unparseable input. */
function parseBound(v?: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}

/**
 * Upper bound for a date range. A bare `YYYY-MM-DD` parses as midnight UTC, so a
 * plain `lte` would exclude everything that happened later that same day — the
 * "to = today shows nothing from today" bug. For a date-only value we make the
 * bound the END of that day so the range is inclusive of it.
 */
function parseUpperBound(v?: string): Date | undefined {
  const d = parseBound(v);
  if (!d) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v!.trim())) {
    d.setUTCHours(23, 59, 59, 999);
  }
  return d;
}

function toRow(r: any) {
  return {
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    actorName: r.actorName,
    actorRole: r.actorRole,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    storeId: r.storeId ?? null,
    summary: r.summary,
    metadata: r.metadata ?? null,
  };
}

@Injectable()
export class AuditReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
  ) {}

  /**
   * GET /audit — filtered, paginated, store-scoped audit trail (newest first).
   * Store-scoping applies to `storeId`; rows with a null storeId (e.g. role
   * changes) fall out of any `storeId in [...]` filter, so only head_office
   * (unfiltered scope) sees them.
   */
  async list(user: AuthUser, q: AuditQuery, headerStore?: string) {
    const where: Prisma.AuditLogWhereInput = {
      // An in-page store dropdown (q.storeId) takes precedence over the global
      // switcher; storeFilter validates it against the caller's scope either way,
      // so a store manager can never widen past their own store(s).
      ...this.scope.storeFilter(user, q.storeId ?? headerStore),
    };
    if (q.entityType) where.entityType = q.entityType;
    if (q.entityId) where.entityId = q.entityId;
    if (q.action) where.action = q.action;
    // Parse date bounds defensively — a garbage ?from=/&to= must not reach Prisma
    // as an Invalid Date (which would 500). Silently ignore unparseable values.
    const from = parseBound(q.from);
    const to = parseUpperBound(q.to);
    if (from || to) {
      where.createdAt = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      };
    }

    const pg = parsePagination(q.page, q.pageSize) ?? { page: 1, pageSize: DEFAULT_PAGE_SIZE };

    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (pg.page - 1) * pg.pageSize,
        take: pg.pageSize,
      }),
    ]);

    // Resolve store names for the page (batched) so the UI shows "Surat — Main"
    // rather than a raw store id, and the export/detail read cleanly.
    const storeIds = [...new Set(rows.map((r) => r.storeId).filter((s): s is string => !!s))];
    const stores = storeIds.length
      ? await this.prisma.store.findMany({
          where: { id: { in: storeIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(stores.map((s) => [s.id, s.name]));

    return {
      items: rows.map((r) => ({ ...toRow(r), storeName: r.storeId ? nameById.get(r.storeId) ?? null : null })),
      page: pg.page,
      pageSize: pg.pageSize,
      total,
    };
  }
}
