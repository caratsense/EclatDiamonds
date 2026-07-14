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
  page?: string;
  pageSize?: string;
}

/** Parse a date-bound query param; returns undefined for missing/unparseable input. */
function parseBound(v?: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
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
      ...this.scope.storeFilter(user, headerStore),
    };
    if (q.entityType) where.entityType = q.entityType;
    if (q.entityId) where.entityId = q.entityId;
    if (q.action) where.action = q.action;
    // Parse date bounds defensively — a garbage ?from=/&to= must not reach Prisma
    // as an Invalid Date (which would 500). Silently ignore unparseable values.
    const from = parseBound(q.from);
    const to = parseBound(q.to);
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

    return { items: rows.map(toRow), page: pg.page, pageSize: pg.pageSize, total };
  }
}
