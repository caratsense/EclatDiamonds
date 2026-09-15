import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Workbook } from 'exceljs';

import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { businessDate, resolveTz } from '../common/tz.util';
import { leadSearchWhere, leadTagWhere } from '../leads/lead-filters';

/**
 * Hard ceiling on one export.
 *
 * Not a page size — the whole point of an export is that it is not paginated.
 * It is the point past which ExcelJS's in-memory workbook stops being safe on a
 * shared container. A request that would exceed it is REFUSED with the real
 * count and told to narrow the range, because a silently truncated spreadsheet
 * is worse than no spreadsheet: nobody can see the rows that are missing.
 */
export const EXPORT_ROW_LIMIT = 50_000;

/** Every column the export can carry, in the order a person reads them. */
export const EXPORT_COLUMNS = [
  'customerName',
  'phone',
  'ref',
  'store',
  'owner',
  'source',
  'campaign',
  'adId',
  'tags',
  'stage',
  'outcome',
  'createdAt',
  'lastActivity',
  'nextFollowUp',
  'visitCount',
  'value',
] as const;

export type ExportColumn = (typeof EXPORT_COLUMNS)[number];

const HEADINGS: Record<ExportColumn, string> = {
  customerName: 'Customer',
  phone: 'Phone',
  ref: 'Lead ref',
  store: 'Store',
  owner: 'Owner',
  source: 'Source',
  campaign: 'Campaign',
  adId: 'Ad ID',
  tags: 'Tags',
  stage: 'Stage',
  outcome: 'Outcome',
  createdAt: 'Created',
  lastActivity: 'Last activity',
  nextFollowUp: 'Next follow-up',
  visitCount: 'Visits',
  value: 'Value',
};

/** Widths chosen so the common case needs no manual resizing in Excel. */
const WIDTHS: Record<ExportColumn, number> = {
  customerName: 26, phone: 16, ref: 14, store: 20, owner: 20, source: 14,
  campaign: 26, adId: 20, tags: 28, stage: 14, outcome: 12, createdAt: 12,
  lastActivity: 12, nextFollowUp: 14, visitCount: 8, value: 14,
};

export interface LeadExportFilters {
  from?: string;
  to?: string;
  /**
   * Exact window bounds, when the caller has already resolved them.
   *
   * `from`/`to` are calendar dates read as UTC days, which is close enough for a
   * manager picking a range by hand. A scheduled month-end report is not: in
   * Asia/Kolkata a lead created at 02:00 on the 1st is 20:30 UTC on the previous
   * day, so an unadjusted month boundary files it in the wrong month's report —
   * the one figure the client will reconcile against. The scheduled path
   * computes the boundary in the BRANCH's timezone and passes the instants here.
   *
   * `toInstant` is exclusive; `to` remains inclusive of its whole day.
   */
  fromInstant?: Date;
  toInstant?: Date;
  storeId?: string;
  ownerId?: string;
  source?: string;
  stage?: string;
  outcome?: string;
  tagIds?: string[];
  q?: string;
  columns?: ExportColumn[];
  /** Basename for the workbook, without the extension. Defaults to the date. */
  filenameStem?: string;
}

@Injectable()
export class LeadExportService {
  private readonly log = new Logger(LeadExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Build the WHERE clause.
   *
   * Organisation and store scope come from the caller's token and are applied
   * LAST, so a `storeId` in the query can only ever narrow what the token already
   * allows — never widen it. `storeFilter` throws if the requested store is not
   * theirs, which is what stops a salesperson exporting the whole chain.
   */
  private where(user: AuthUser, f: LeadExportFilters): Prisma.LeadWhereInput {
    const and: Prisma.LeadWhereInput[] = [];

    if (f.fromInstant || f.toInstant) {
      // Already resolved by the caller, exclusive upper bound. Takes precedence:
      // a caller that did the timezone work must not have it re-approximated.
      const createdAt: Prisma.DateTimeFilter = {};
      if (f.fromInstant) createdAt.gte = f.fromInstant;
      if (f.toInstant) createdAt.lt = f.toInstant;
      and.push({ createdAt });
    } else if (f.from || f.to) {
      const createdAt: Prisma.DateTimeFilter = {};
      if (f.from) createdAt.gte = new Date(`${f.from}T00:00:00.000Z`);
      // Inclusive of the end date: a person asking for 1–30 September means the
      // whole of the 30th, not up to midnight at its start.
      if (f.to) createdAt.lt = new Date(new Date(`${f.to}T00:00:00.000Z`).getTime() + 86_400_000);
      and.push({ createdAt });
    }
    if (f.ownerId) and.push({ ownerId: f.ownerId });
    if (f.source) and.push({ source: f.source as Prisma.EnumLeadSourceFilter['equals'] });
    if (f.stage) and.push({ stage: f.stage as Prisma.EnumLeadStageFilter['equals'] });
    if (f.outcome) and.push({ outcome: f.outcome });
    const tagged = leadTagWhere(user.organisationId, f.tagIds);
    if (tagged) and.push(tagged);
    const searched = leadSearchWhere(f.q);
    if (searched) and.push(searched);

    return {
      ...this.scope.orgFilter(user),
      ...this.scope.storeFilter(user, f.storeId),
      ...(and.length ? { AND: and } : {}),
    };
  }

  /** How many rows this filter would produce, counted in the database. */
  async count(user: AuthUser, f: LeadExportFilters): Promise<number> {
    return this.prisma.lead.count({ where: this.where(user, f) });
  }

  /**
   * Build the workbook.
   *
   * Returns a real XLSX buffer from ExcelJS — not CSV with an .xlsx name, which
   * Excel opens with a security warning and which loses every date and number
   * type on the way in.
   */
  async build(
    user: AuthUser,
    f: LeadExportFilters,
  ): Promise<{ buffer: Buffer; filename: string; rows: number }> {
    const columns = (f.columns?.length ? f.columns : EXPORT_COLUMNS).filter(
      (c): c is ExportColumn => (EXPORT_COLUMNS as readonly string[]).includes(c),
    );
    if (!columns.length) throw new BadRequestException('Choose at least one column to export.');

    const where = this.where(user, f);
    const total = await this.prisma.lead.count({ where });
    if (total > EXPORT_ROW_LIMIT) {
      throw new BadRequestException(
        `That filter matches ${total.toLocaleString('en-IN')} leads, over the ${EXPORT_ROW_LIMIT.toLocaleString('en-IN')} limit for one file. Narrow the date range or pick one store.`,
      );
    }

    const leads = await this.prisma.lead.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        ref: true, customerName: true, phone: true, source: true, stage: true,
        outcome: true, value: true, createdAt: true, lastActivity: true, attributes: true,
        store: { select: { name: true, timezone: true } },
        owner: { select: { name: true } },
        tagAssignments: { select: { tag: { select: { name: true } } } },
        followUps: {
          where: { done: false },
          orderBy: { dueDate: 'asc' },
          take: 1,
          select: { dueDate: true },
        },
        party: { select: { _count: { select: { checkIns: true } } } },
      },
    });

    const wb = new Workbook();
    wb.creator = 'CaratSense';
    wb.created = new Date();
    const ws = wb.addWorksheet('Leads', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    ws.columns = columns.map((c) => ({
      header: HEADINGS[c],
      key: c,
      width: WIDTHS[c],
    }));
    ws.getRow(1).font = { bold: true };

    for (const lead of leads) {
      const tz = resolveTz(lead.store?.timezone);
      const attrs = (lead.attributes ?? {}) as Record<string, unknown>;
      const row: Record<string, unknown> = {
        customerName: lead.customerName,
        phone: lead.phone ?? '',
        ref: lead.ref,
        store: lead.store?.name ?? '',
        owner: lead.owner?.name ?? '',
        source: lead.source,
        // Campaign and ad id exist only for leads that actually came from an ad.
        // Blank is the honest answer for a walk-in, not "N/A" or "Organic".
        campaign: typeof attrs.campaignName === 'string' ? attrs.campaignName : '',
        adId: typeof attrs.adId === 'string' ? attrs.adId : '',
        tags: lead.tagAssignments.map((a) => a.tag.name).join(', '),
        stage: lead.stage,
        outcome: lead.outcome,
        createdAt: businessDate(lead.createdAt, tz),
        lastActivity: lead.lastActivity ? businessDate(lead.lastActivity, tz) : '',
        nextFollowUp: lead.followUps[0]?.dueDate
          ? businessDate(lead.followUps[0].dueDate, tz)
          : '',
        visitCount: lead.party?._count.checkIns ?? 0,
        value: lead.value ? Number(lead.value) : '',
      };
      ws.addRow(Object.fromEntries(columns.map((c) => [c, row[c]])));
    }

    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: columns.length },
    };

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const stamp = new Date().toISOString().slice(0, 10);
    // A scheduled report names the period it covers; a manual one names the day
    // it was taken. "leads-2026-08.xlsx" in an inbox answers a question that
    // "leads-2026-09-01.xlsx" makes somebody open the file to answer.
    const filename = f.filenameStem ? `${f.filenameStem}.xlsx` : `leads-${stamp}.xlsx`;

    /*
     * Exports are audited because the file leaves the system carrying customer
     * names and phone numbers. The trail records what was asked for, not the
     * rows themselves — logging the contents would put the same personal data
     * in a second place.
     */
    await this.audit.record(user, {
      action: 'crm.leads.exported',
      entityType: 'lead_export',
      entityId: `${user.organisationId}:${stamp}`,
      storeId: f.storeId ?? null,
      summary: `Exported ${leads.length} lead(s) to Excel`,
      metadata: {
        rows: leads.length,
        filters: {
          from: f.from ?? null, to: f.to ?? null, storeId: f.storeId ?? null,
          ownerId: f.ownerId ?? null, source: f.source ?? null, stage: f.stage ?? null,
          outcome: f.outcome ?? null, tagIds: f.tagIds ?? [],
        },
        columns,
      },
    });

    return { buffer, filename, rows: leads.length };
  }
}
