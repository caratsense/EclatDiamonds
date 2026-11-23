import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Workbook } from 'exceljs';

import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { PRODUCT_NAME } from '../common/brand';
import {
  type ExportColumnFormat,
  type ExportFormatKind,
  LEAD_EXPORT_FIELDS,
  defaultExportFormat,
  exportFieldCatalogue,
  exportFieldWidth,
  readExportFormat,
  sanitiseExportFormat,
  withExportFormat,
} from '../common/export-formats';
import {
  addExportAboutSheet,
  rangeFilename,
  rangeWhere,
  resolveExportRange,
} from '../common/export-range';
import { updateOrgSettings } from '../config/org-settings';
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

/**
 * Every column the export can carry.
 *
 * The list itself now lives in `common/export-formats.ts`, beside the field
 * catalogue the chooser is built from, so the two cannot drift: a column offered
 * in Settings that the builder below cannot fill would reach a person only as a
 * blank column in a file they have already forwarded.
 */
export const EXPORT_COLUMNS = LEAD_EXPORT_FIELDS.map((f) => f.field) as readonly string[];

export type ExportColumn = (typeof LEAD_EXPORT_FIELDS)[number]['field'];

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
   *
   * The range goes on `createdAt` because that is the column the client's own
   * sheet calls "Date": she means the leads that CAME IN during the window, not
   * the ones touched during it. Ranging on `lastActivity` would put an August
   * lead in a November file the moment somebody rang them.
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
      and.push(rangeWhere('createdAt', resolveExportRange(f.from, f.to)));
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

  // ================================================== per-tenant sheet format

  /**
   * The tenant's chosen columns for one export, or the default.
   *
   * Lives on this service rather than a service of its own because it reads one
   * key off `Organisation.settings` and both call sites are export call sites.
   * The NPS export reads the same key through `readExportFormat` directly — it
   * needs no injection to do it, and inventing a provider for one `findUnique`
   * would mean registering it in four modules.
   */
  async format(user: AuthUser, kind: ExportFormatKind): Promise<readonly ExportColumnFormat[]> {
    const org = await this.prisma.organisation.findUnique({
      where: { id: user.organisationId },
      select: { settings: true },
    });
    return readExportFormat(org?.settings, kind);
  }

  /** What the chooser offers, and what this tenant currently has. */
  async formats(user: AuthUser) {
    const org = await this.prisma.organisation.findUnique({
      where: { id: user.organisationId },
      select: { settings: true },
    });
    return {
      leads: this.describeFormat(org?.settings, 'leads'),
      nps: this.describeFormat(org?.settings, 'nps'),
    };
  }

  private describeFormat(settings: unknown, kind: ExportFormatKind) {
    const columns = readExportFormat(settings, kind);
    const theDefault = defaultExportFormat(kind);
    return {
      kind,
      columns,
      /*
       * Whether this is OUR default or THEIRS. The screen needs to be able to
       * say so: a tenant looking at the client's twenty columns cannot otherwise
       * tell whether somebody here chose them or whether they shipped that way,
       * and "Reset to the standard format" is a frightening button if you cannot
       * see that you are already on it.
       */
      isDefault: columns === theDefault,
      fields: exportFieldCatalogue(kind),
      defaultColumns: theDefault,
    };
  }

  /** Save a format, or pass `null` to go back to the default. */
  async saveFormat(
    user: AuthUser,
    kind: ExportFormatKind,
    columns: unknown[] | null,
  ): Promise<readonly ExportColumnFormat[]> {
    const next = columns === null ? null : sanitiseExportFormat(kind, columns);
    await updateOrgSettings(this.prisma, user.organisationId, (current) =>
      withExportFormat(current, kind, next),
    );
    await this.audit.record(user, {
      action: 'exports.format.changed',
      entityType: 'export_format',
      entityId: `${user.organisationId}:${kind}`,
      storeId: null,
      summary:
        next === null
          ? `Put the ${kind} sheet back to the standard format`
          : `Set the ${kind} sheet to ${next.length} column(s)`,
      metadata: { kind, columns: next },
    });
    return next ?? defaultExportFormat(kind);
  }

  // ========================================================== the workbook

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
    const format = await this.resolveFormat(user, f);
    if (!format.length) throw new BadRequestException('Choose at least one column to export.');

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
        outcome: true, value: true, createdAt: true, closedAt: true, lastActivity: true,
        location: true, interest: true, attributes: true,
        store: { select: { name: true, timezone: true } },
        owner: { select: { name: true } },
        /*
         * Fetched whether or not the chosen columns read them.
         *
         * Gating each relation on `format` was tried and reverted: a conditional
         * value inside a Prisma `select` collapses the inferred payload back to
         * the whole row, so the saving cost the one thing that makes the builder
         * below safe — the compiler knowing exactly which fields were asked for.
         * Each of these is one `take: 1` sub-select bounded by EXPORT_ROW_LIMIT,
         * and the first three were always fetched anyway.
         */
        tagAssignments: { select: { tag: { select: { name: true } } } },
        followUps: {
          where: { done: false },
          orderBy: { dueDate: 'asc' },
          take: 1,
          select: { dueDate: true },
        },
        party: { select: { _count: { select: { checkIns: true } } } },
        // The walk-in register's answers come from the lead's most recent visit.
        visits: {
          orderBy: { timeIn: 'desc' },
          take: 1,
          select: { metadata: true, store: { select: { name: true } } },
        },
        notes: { orderBy: { createdAt: 'desc' }, take: 1, select: { text: true } },
      },
    });

    const wb = new Workbook();
    wb.creator = PRODUCT_NAME;
    wb.created = new Date();
    const ws = wb.addWorksheet('Leads', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    ws.columns = format.map((c) => ({
      header: c.header,
      key: c.field,
      width: exportFieldWidth('leads', c.field),
    }));
    ws.getRow(1).font = { bold: true };

    leads.forEach((lead, index) => {
      const row = leadRow(lead, index);
      ws.addRow(Object.fromEntries(format.map((c) => [c.field, row[c.field] ?? ''])));
    });

    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: format.length },
    };

    // What this file covers, inside the file. Two downloads with the same name
    // and different row counts is the next question we get asked.
    addExportAboutSheet(wb, {
      what: 'Leads',
      rangedOn: 'The day the lead arrived',
      from: f.from,
      to: f.to,
      rows: leads.length,
      notes: [['Columns', format.map((c) => c.header).join(' | ')]],
    });

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const stamp = new Date().toISOString().slice(0, 10);
    /*
     * The name says what is inside.
     *
     * A scheduled report names the period it covers. A manual one names the
     * RANGE when there is one — "leads-2026-11-01-to-2026-11-30.xlsx" in an
     * inbox answers a question that "leads-2026-11-21.xlsx" makes somebody open
     * the file to answer — and falls back to the day it was taken for an
     * all-time download, which is the name that has always been used.
     */
    const filename = f.filenameStem
      ? `${f.filenameStem}.xlsx`
      : f.from || f.to
        ? rangeFilename('leads', f.from, f.to)
        : `leads-${stamp}.xlsx`;

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
        columns: format.map((c) => c.field),
      },
    });

    return { buffer, filename, rows: leads.length };
  }

  /**
   * Which columns this workbook gets.
   *
   * An explicit `columns=` in the query still wins, because the scheduled
   * reports and the CRM board's own chooser pass one and must keep producing the
   * sheet they were configured for. Everything else gets the tenant's format.
   */
  private async resolveFormat(
    user: AuthUser,
    f: LeadExportFilters,
  ): Promise<readonly ExportColumnFormat[]> {
    if (!f.columns?.length) return this.format(user, 'leads');
    const catalogue = exportFieldCatalogue('leads');
    return f.columns
      .map((field) => catalogue.find((spec) => spec.field === field))
      .filter((spec): spec is (typeof LEAD_EXPORT_FIELDS)[number] => spec != null)
      .map((spec) => ({ field: spec.field, header: spec.label }));
  }
}

/**
 * The lead as Prisma hands it back, with every gated relation optional.
 *
 * `leadRow` and `transactionChannel` below are exported only so their rules can
 * be asserted directly (see `lead-export-rows.spec.ts`). Both decide something
 * whose failure reaches a person as a wrong spreadsheet rather than as an error:
 * an open lead counted as a non-purchase, or a sales column that sums to more
 * than was actually sold.
 */
export type LeadRecord = {
  ref: string;
  customerName: string;
  phone: string | null;
  source: string;
  stage: string;
  outcome: string;
  value: Prisma.Decimal | null;
  createdAt: Date;
  closedAt: Date | null;
  lastActivity: Date | null;
  location: string | null;
  interest: string | null;
  attributes: Prisma.JsonValue | null;
  store: { name: string; timezone: string | null } | null;
  owner: { name: string } | null;
  tagAssignments?: { tag: { name: string } }[];
  followUps?: { dueDate: Date | null }[];
  party?: { _count: { checkIns: number } } | null;
  visits?: { metadata: Prisma.JsonValue | null; store: { name: string } | null }[];
  notes?: { text: string }[];
};

/**
 * Where the transaction happened, read off the source rather than guessed.
 *
 * Only two sources say it: a website lead transacted on the website, a walk-in
 * transacted in the shop. A Meta ad says where the lead CAME FROM and nothing
 * about where it closed, so it stays blank — the client's own column has two
 * values in it, and filling a third in for her would put a number in a count she
 * reconciles by hand.
 */
export function transactionChannel(source: string): string {
  if (source === 'website') return 'Website';
  if (source === 'walk_in') return 'Store';
  return '';
}

export function leadRow(lead: LeadRecord, index: number): Record<string, unknown> {
  const tz = resolveTz(lead.store?.timezone);
  const attrs = (lead.attributes ?? {}) as Record<string, unknown>;
  const visit = lead.visits?.[0];
  const survey = (visit?.metadata ?? {}) as Record<string, unknown>;
  const won = lead.outcome === 'won';
  const str = (v: unknown) => (typeof v === 'string' ? v : '');

  return {
    serial: index + 1,
    customerName: lead.customerName,
    phone: lead.phone ?? '',
    ref: lead.ref,
    store: lead.store?.name ?? '',
    storeVisited: visit?.store?.name ?? '',
    owner: lead.owner?.name ?? '',
    source: lead.source,
    // Campaign and ad id exist only for leads that actually came from an ad.
    // Blank is the honest answer for a walk-in, not "N/A" or "Organic".
    campaign: str(attrs.campaignName),
    adId: str(attrs.adId),
    channel: transactionChannel(lead.source),
    location: lead.location ?? '',
    // The walk-in register's own answers, read through the most recent visit.
    // Blank when they have never been in — the register is where these are
    // asked, so there is nowhere else they could have come from.
    customerType: str(survey.customerType),
    productCategory: str(survey.productCategory),
    interest: lead.interest ?? '',
    occasion: str(survey.occasion),
    tags: (lead.tagAssignments ?? []).map((a) => a.tag.name).join(', '),
    stage: lead.stage,
    outcome: lead.outcome,
    /*
     * The client's words, not ours. Her sheet has three states in this column
     * and the third one is empty: a lead still being worked is neither a
     * purchase nor a non-purchase, and calling it "Non-purchase" today would
     * overstate every branch's loss rate in her Summary tab.
     */
    purchaseStatus: won ? 'Purchase' : lead.outcome === 'lost' ? 'Non-purchase' : '',
    value: lead.value ? Number(lead.value) : '',
    // Only on a won lead, so a column of these sums to money that came in.
    salesValue: won && lead.value ? Number(lead.value) : '',
    createdAt: businessDate(lead.createdAt, tz),
    saleDate: won && lead.closedAt ? businessDate(lead.closedAt, tz) : '',
    lastActivity: lead.lastActivity ? businessDate(lead.lastActivity, tz) : '',
    nextFollowUp: lead.followUps?.[0]?.dueDate
      ? businessDate(lead.followUps[0].dueDate as Date, tz)
      : '',
    visitCount: lead.party?._count.checkIns ?? 0,
    remarks: lead.notes?.[0]?.text ?? '',
  };
}

