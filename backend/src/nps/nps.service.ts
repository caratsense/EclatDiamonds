import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuthUser } from '../common/auth-user';
import { exportFieldWidth, readExportFormat } from '../common/export-formats';
import {
  ExportRange,
  addExportAboutSheet,
  rangeFilename,
  rangeWhere,
  resolveExportRange,
} from '../common/export-range';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { instantFromLocalTime, zonedParts } from '../common/tz.util';
import { NPS_STAGE_LABELS, NpsStage, npsReplyState, npsStage } from './nps-stage';
import {
  MatchCandidate,
  matchNpsResponse,
  normaliseNpsPhone,
  npsImportKey,
  parseRecommendScore,
} from './nps-match';
import {
  NpsSheetNames,
  SkippedRow,
  mapFollowupRows,
  mapResponseRows,
  readNpsUpload,
} from './nps-sheet';

/** One row of the client's NPS Responses sheet, as read by a connector. */
export interface NpsResponseRow {
  submittedAt: Date;
  name?: unknown;
  number?: unknown;
  firstPurchase?: unknown;
  recommendAnswer?: unknown;
  visitPurpose?: unknown;
  likedMost?: unknown;
  couldImprove?: unknown;
  notFound?: unknown;
  heardAboutUs?: unknown;
  followsSocial?: unknown;
  concerns?: unknown;
}

/** One row of the client's "Followup answers" sheet. */
export interface NpsFollowupRow {
  submittedAt: Date;
  followupDate?: Date | null;
  name?: unknown;
  number?: unknown;
  response?: unknown;
}

/** What one uploaded sheet did, in the terms the screen reports it. */
export interface NpsSheetImportSummary {
  /** The tab it came from, as the workbook spells it. */
  sheet: string;
  received: number;
  created: number;
  updated: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  /** Rows that could not become records, with the reason for each. */
  skipped: SkippedRow[];
  /** Columns no question claimed — a renamed header shows up here first. */
  ignoredColumns: string[];
}

export interface NpsImportResult {
  file: string | null;
  /** Every tab in the uploaded workbook, so the caller can see what was skipped. */
  sheetNames: string[];
  responses: NpsSheetImportSummary | null;
  followups: NpsSheetImportSummary | null;
}

/**
 * The ask behind a visit, fetched separately from the visit itself because
 * `FeedbackRequest.checkInId` carries no foreign key — see `updates()`.
 */
interface NpsAsk {
  id: string;
  checkInId: string | null;
  status: string;
  sentAt: Date | null;
  respondedAt: Date | null;
  repliedAt: Date | null;
  reminderDueAt: Date | null;
  reminderSentAt: Date | null;
  rating: number | null;
  deliveryNote: string | null;
  dispatchAttempts: number;
}

/** An import summary as one log-safe phrase. */
const summarise = (s: NpsSheetImportSummary | null): string =>
  s
    ? `${s.received} rows (${s.created} new, ${s.updated} updated, ${s.matched} matched, ${s.ambiguous} ambiguous, ${s.unmatched} unmatched, ${s.skipped.length} skipped)`
    : 'no sheet';

const text = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, 2000) : null;
};

/**
 * CRM › NPS.
 *
 * Two screens over three kinds of fact that the client's workbook keeps apart
 * and so does this: the ASK (did we message them, did they reply), the
 * SUBMISSION (did they fill the form), and the FOLLOW-UP (what they said when
 * somebody chased them). Collapsing any two of those is the mistake the
 * client's brief spends most of its words guarding against.
 */
@Injectable()
export class NpsService {
  private readonly logger = new Logger(NpsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
  ) {}

  // ============================================================== NPS Updates

  /**
   * One row per eligible visit, INCLUDING customers who never responded.
   *
   * Driven from CheckIn rather than from FeedbackRequest, because a visit with
   * no ask yet is exactly the row the branch most needs to see — a list built
   * from requests would show only the people we already messaged and would
   * silently hide everybody we had not.
   */
  async updates(
    user: AuthUser,
    opts: { storeId?: string; stage?: NpsStage; from?: Date; to?: Date; take?: number; skip?: number } = {},
  ) {
    const where: Prisma.CheckInWhereInput = {
      ...this.scope.storeFilter(user, opts.storeId),
      ...(opts.from || opts.to
        ? { timeIn: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } }
        : {}),
    };

    const take = Math.min(Math.max(opts.take ?? 100, 1), 500);
    const rows = await this.prisma.checkIn.findMany({
      where,
      orderBy: { timeIn: 'desc' },
      take,
      skip: opts.skip ?? 0,
      select: this.updateSelect(),
    });

    /*
     * The asks are fetched separately rather than through a relation.
     * `FeedbackRequest.checkInId` is a loose id with no foreign key — the model
     * deliberately allows an ask to hang off a visit, a sale or a task — and
     * adding one now would validate against every historical row, so a single
     * ask pointing at a since-deleted visit would fail the migration on
     * production. A second query costs one round trip and no risk.
     */
    const asks = rows.length
      ? await this.prisma.feedbackRequest.findMany({
          where: { organisationId: user.organisationId, checkInId: { in: rows.map((r) => r.id) } },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, checkInId: true, status: true, sentAt: true, respondedAt: true,
            repliedAt: true, reminderDueAt: true, reminderSentAt: true, rating: true,
            deliveryNote: true, dispatchAttempts: true,
          },
        })
      : [];
    // Newest per visit: a repeat visitor may have several over time.
    const latestAsk = new Map<string, (typeof asks)[number]>();
    for (const a of asks) {
      if (a.checkInId && !latestAsk.has(a.checkInId)) latestAsk.set(a.checkInId, a);
    }

    const mapped = rows.map((r) => this.toUpdate(r, latestAsk.get(r.id) ?? null));
    const filtered = opts.stage ? mapped.filter((m) => m.stage === opts.stage) : mapped;
    return { rows: filtered, total: await this.prisma.checkIn.count({ where }) };
  }

  private updateSelect() {
    return {
      id: true,
      customerName: true,
      phone: true,
      timeIn: true,
      visitDate: true,
      repName: true,
      managerName: true,
      npsMessageSentAt: true,
      npsResponseReceivedAt: true,
      partyId: true,
      store: { select: { id: true, name: true } },
      party: { select: { id: true, name: true } },
      npsResponses: {
        orderBy: { submittedAt: 'desc' as const },
        take: 1,
        select: { id: true, submittedAt: true, score: true, recommendAnswer: true, matchState: true },
      },
      npsFollowups: {
        orderBy: { submittedAt: 'desc' as const },
        select: { id: true, submittedAt: true, followupDate: true, response: true },
      },
    };
  }

  private toUpdate(
    r: Awaited<ReturnType<NpsService['rawUpdate']>>,
    ask: NpsAsk | null,
  ) {
    const response = r.npsResponses[0] ?? null;
    const facts = {
      status: ask?.status,
      sentAt: ask?.sentAt ?? r.npsMessageSentAt,
      reminderDueAt: ask?.reminderDueAt,
      reminderSentAt: ask?.reminderSentAt,
      repliedAt: ask?.repliedAt,
      respondedAt: ask?.respondedAt ?? r.npsResponseReceivedAt,
      hasMatchedResponse: !!response && response.matchState === 'matched',
      failed: (ask?.dispatchAttempts ?? 0) >= 5 && !ask?.sentAt,
    };
    const stage = npsStage(facts);

    return {
      checkInId: r.id,
      partyId: r.partyId,
      customerName: r.party?.name ?? r.customerName,
      phone: r.phone,
      store: r.store?.name ?? null,
      storeId: r.store?.id ?? null,
      visitAt: r.timeIn,
      visitDate: r.visitDate,
      salesperson: r.repName,
      manager: r.managerName,

      stage,
      stageLabel: NPS_STAGE_LABELS[stage],
      replyState: npsReplyState(facts),

      requestId: ask?.id ?? null,
      initialSentAt: facts.sentAt ?? null,
      reminderDueAt: ask?.reminderDueAt ?? null,
      reminderSentAt: ask?.reminderSentAt ?? null,
      repliedAt: ask?.repliedAt ?? null,
      submittedAt: response?.submittedAt ?? ask?.respondedAt ?? r.npsResponseReceivedAt ?? null,
      score: response?.score ?? ask?.rating ?? null,
      scoreAnswer: response?.recommendAnswer ?? null,
      // Only ever populated from a provider failure, never inferred.
      failureNote: ask?.deliveryNote ?? null,
      attempts: ask?.dispatchAttempts ?? 0,

      followups: r.npsFollowups.map((f) => ({
        id: f.id,
        at: f.submittedAt,
        date: f.followupDate,
        response: f.response,
      })),
    };
  }

  /** Types the select above for `toUpdate`, without repeating it. */
  private rawUpdate() {
    return this.prisma.checkIn.findFirstOrThrow({ select: this.updateSelect() });
  }

  // ============================================================ NPS Responses

  async responses(
    user: AuthUser,
    opts: { matchState?: string; take?: number; skip?: number } = {},
  ) {
    const where: Prisma.NpsResponseWhereInput = {
      organisationId: user.organisationId,
      ...(opts.matchState ? { matchState: opts.matchState } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.npsResponse.findMany({
        where,
        orderBy: { submittedAt: 'desc' },
        take: Math.min(Math.max(opts.take ?? 100, 1), 500),
        skip: opts.skip ?? 0,
        include: {
          party: { select: { id: true, name: true } },
          checkIn: { select: { id: true, timeIn: true, store: { select: { name: true } } } },
        },
      }),
      this.prisma.npsResponse.count({ where }),
    ]);
    return { rows, total };
  }

  // =================================================================== import

  /**
   * The client's own export, uploaded from the NPS screen.
   *
   * This is the only route data has into NPS. Everything downstream of it —
   * the model, the matcher, the two screens, the Excel export — was built and
   * then sat empty, because nothing called the importers: production held 0
   * responses and 0 follow-ups, so the module could not be tested at all.
   *
   * Both tabs in one upload, because that is how the file arrives. A workbook
   * holding only one of them is imported on its own rather than refused: she
   * sends whichever sheet she has updated.
   */
  async importUpload(
    user: AuthUser,
    file: { buffer?: Buffer; originalname?: string } | undefined,
    names: NpsSheetNames = {},
  ): Promise<NpsImportResult> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file uploaded. Attach the NPS sheet as `file`.');
    }
    const tables = await readNpsUpload(file.buffer, file.originalname, names);
    /*
     * Sheet timestamps carry no offset, so they are read as the shop's own wall
     * clock — see `parseNpsTimestamp`. The tenant's branches are all in one
     * zone today; when that stops being true the branch's own timezone belongs
     * here, not a second guess at the sheet.
     */
    const responseRows = tables.responses ? mapResponseRows(tables.responses) : null;
    const followupRows = tables.followups ? mapFollowupRows(tables.followups) : null;

    let responses: NpsSheetImportSummary | null = null;
    if (tables.responses && responseRows) {
      const counts = await this.importResponses(user.organisationId, responseRows.rows);
      responses = {
        sheet: tables.responses.name,
        ...counts,
        skipped: responseRows.skipped,
        ignoredColumns: responseRows.ignoredColumns,
      };
    }

    let followups: NpsSheetImportSummary | null = null;
    if (tables.followups && followupRows) {
      const counts = await this.importFollowups(user.organisationId, followupRows.rows);
      followups = {
        sheet: tables.followups.name,
        ...counts,
        skipped: followupRows.skipped,
        ignoredColumns: followupRows.ignoredColumns,
      };
    }

    // Counts only: an NPS row is a named customer's opinion of the shop, and a
    // log line is the last place that should hold it.
    this.logger.log(
      `NPS import by ${user.id}: responses ${summarise(responses)}, follow-ups ${summarise(followups)}`,
    );
    return { file: file.originalname ?? null, sheetNames: tables.sheetNames, responses, followups };
  }

  /**
   * Ingest submissions.
   *
   * Historical rows are imported WITHOUT messaging anybody: this writes
   * responses and links them, and never creates or sends an ask. That is the
   * client's explicit instruction and also the only safe default — a bulk
   * import that messaged 1,900 historical walk-ins would be unrecoverable.
   *
   * Idempotent by `importKey`, falling back to the submission's own instant
   * (see `sameSubmission`) so that re-running the sheet updates rather than
   * duplicates even when a cell in the row has since been corrected.
   */
  async importResponses(organisationId: string, rows: NpsResponseRow[]) {
    const summary = { received: rows.length, created: 0, updated: 0, matched: 0, ambiguous: 0, unmatched: 0 };
    /** Records this upload has already written — see `sameSubmission`. */
    const claimed = new Set<string>();

    for (const row of rows) {
      const phoneE164 = normaliseNpsPhone(row.number);
      const importKey = npsImportKey(organisationId, row.submittedAt, phoneE164, 'response');
      const match = await this.resolveMatch(organisationId, row.submittedAt, phoneE164);

      const data = {
        organisationId,
        submittedAt: row.submittedAt,
        rawName: text(row.name),
        rawNumber: text(row.number),
        phoneE164,
        firstPurchase: text(row.firstPurchase),
        recommendAnswer: text(row.recommendAnswer),
        visitPurpose: text(row.visitPurpose),
        likedMost: text(row.likedMost),
        couldImprove: text(row.couldImprove),
        notFound: text(row.notFound),
        heardAboutUs: text(row.heardAboutUs),
        followsSocial: text(row.followsSocial),
        concerns: text(row.concerns),
        score: parseRecommendScore(row.recommendAnswer),
        matchState: match.state,
        matchNote: match.note,
        partyId: match.partyId,
        checkInId: match.checkInId,
      };

      const existing =
        (await this.prisma.npsResponse.findUnique({ where: { importKey }, select: { id: true } })) ??
        (await this.sameSubmission(organisationId, row.submittedAt, claimed));
      if (existing) {
        // By id, and carrying the key: a corrected number means the row's
        // `importKey` has changed, and leaving the old one in place would make
        // the NEXT upload miss it the same way.
        await this.prisma.npsResponse.update({ where: { id: existing.id }, data: { ...data, importKey } });
        claimed.add(existing.id);
        summary.updated++;
      } else {
        const created = await this.prisma.npsResponse.create({
          data: { ...data, importKey },
          select: { id: true },
        });
        claimed.add(created.id);
        summary.created++;
      }
      summary[match.state === 'matched' ? 'matched' : match.state === 'ambiguous' ? 'ambiguous' : 'unmatched']++;

      if (match.state === 'matched' && match.checkInId) {
        await this.onMatched(organisationId, match.checkInId, row.submittedAt);
      }
    }
    return summary;
  }

  /**
   * The record of the same submission, found WITHOUT the phone number.
   *
   * `npsImportKey` folds the normalised number into the row's identity, so
   * correcting a Number cell in the sheet and re-uploading used to change what
   * the row IS: the key missed, a second record was created, and one customer's
   * answer was counted twice in every average. Correcting a mis-keyed number is
   * the ordinary reason she re-sends the file, so this was the common path.
   *
   * The submission's own instant is the fallback identity. It is the one column
   * Google writes itself, it is never the column being corrected, and it is
   * already half of the import key. It is NOT declared unique, though, so it is
   * trusted only where it actually is unique: if two records share the instant
   * — two people submitting within the same second, rare but possible — neither
   * is touched, because overwriting the wrong answer is worse than the
   * duplicate this is here to prevent. Records written earlier in THIS upload
   * are excluded for the same reason: a second sheet row at the same instant is
   * a different submission, not a correction of the first.
   */
  private async sameSubmission(
    organisationId: string,
    submittedAt: Date,
    claimed: Set<string>,
    // Both sheets carry the same defect and take the same cure, so the table is
    // a parameter rather than this being written twice and drifting.
    table: 'response' | 'followup' = 'response',
  ): Promise<{ id: string } | null> {
    const where = {
      organisationId,
      submittedAt,
      ...(claimed.size ? { id: { notIn: [...claimed] } } : {}),
    };
    const rows =
      table === 'response'
        ? await this.prisma.npsResponse.findMany({ where, select: { id: true }, take: 2 })
        : await this.prisma.npsFollowup.findMany({ where, select: { id: true }, take: 2 });
    return rows.length === 1 ? rows[0] : null;
  }

  async importFollowups(organisationId: string, rows: NpsFollowupRow[]) {
    // Ambiguous and unmatched are counted as well as matched, so a follow-up
    // sheet reports in the same three terms as the responses one: "40 of 50
    // reached nobody" is the number the screen exists to show.
    const summary = { received: rows.length, created: 0, updated: 0, matched: 0, ambiguous: 0, unmatched: 0 };
    /** Records this upload has already written — see `sameSubmission`. */
    const claimed = new Set<string>();
    for (const row of rows) {
      const phoneE164 = normaliseNpsPhone(row.number);
      const importKey = npsImportKey(organisationId, row.submittedAt, phoneE164, 'followup');
      const match = await this.resolveMatch(organisationId, row.submittedAt, phoneE164);
      const data = {
        organisationId,
        submittedAt: row.submittedAt,
        followupDate: row.followupDate ?? null,
        rawName: text(row.name),
        rawNumber: text(row.number),
        phoneE164,
        response: text(row.response),
        matchState: match.state,
        matchNote: match.note,
        partyId: match.partyId,
        checkInId: match.checkInId,
      };
      /*
       * The SAME correction-makes-a-duplicate fault the responses sheet had.
       *
       * `npsImportKey` folds the phone number into the row's identity, so
       * correcting a Number cell and re-uploading changed the key and created a
       * second record — the customer's follow-up counted twice. The fallback
       * adopts the record that shares this submission instant and rewrites its
       * key, so the next upload matches on the key again.
       */
      const existing =
        (await this.prisma.npsFollowup.findUnique({ where: { importKey }, select: { id: true } })) ??
        (await this.sameSubmission(organisationId, row.submittedAt, claimed, 'followup'));
      if (existing) {
        // By id, with the new key in the data, so the identity is corrected
        // rather than left to go stale again on the next upload.
        await this.prisma.npsFollowup.update({
          where: { id: existing.id },
          data: { ...data, importKey },
        });
        claimed.add(existing.id);
        summary.updated++;
      } else {
        const created = await this.prisma.npsFollowup.create({
          data: { ...data, importKey },
          select: { id: true },
        });
        claimed.add(created.id);
        summary.created++;
      }
      summary[match.state === 'matched' ? 'matched' : match.state === 'ambiguous' ? 'ambiguous' : 'unmatched']++;
    }
    return summary;
  }

  /** Candidate visits for a number, newest first, for the matcher to choose from. */
  private async resolveMatch(organisationId: string, submittedAt: Date, phoneE164: string | null) {
    if (!phoneE164) return matchNpsResponse(submittedAt, null, []);
    // Both spellings: rows written before normalisation hold a bare 10-digit
    // number, and ignoring those would leave real matches sitting unmatched.
    const bare = phoneE164.startsWith('91') ? phoneE164.slice(2) : phoneE164;
    const visits = await this.prisma.checkIn.findMany({
      where: { organisationId, phone: { in: [phoneE164, bare, `+${phoneE164}`] } },
      orderBy: { timeIn: 'desc' },
      take: 50,
      select: { id: true, partyId: true, timeIn: true, customerName: true },
    });
    const candidates: MatchCandidate[] = visits.map((v) => ({
      checkInId: v.id,
      partyId: v.partyId,
      visitAt: v.timeIn,
      customerName: v.customerName,
    }));
    return matchNpsResponse(submittedAt, phoneE164, candidates);
  }

  /**
   * A matched submission closes the loop: the walk-in row records it, and any
   * reminder still waiting for that customer is cancelled — chasing somebody
   * who has already answered is the fastest way to be unsubscribed.
   */
  private async onMatched(organisationId: string, checkInId: string, submittedAt: Date) {
    await this.prisma.checkIn.updateMany({
      where: { id: checkInId, organisationId, npsResponseReceivedAt: null },
      data: { npsResponseReceivedAt: submittedAt },
    });
    await this.prisma.feedbackRequest.updateMany({
      where: { organisationId, checkInId, status: { in: ['scheduled', 'pending', 'sent'] } },
      data: { status: 'responded', respondedAt: submittedAt, reminderDueAt: null },
    });
  }

  // =================================================================== export

  /**
   * The whole authorised set, not the visible page: an export that silently
   * stopped at 100 rows would be reconciled against the client's sheet and
   * quietly disagree with it.
   *
   * ## The range, and which column it applies to
   *
   * Each of the three sheets is dated by the thing that sheet is ABOUT, which is
   * not the same column:
   *
   * - **NPS Updates** by the visit's `timeIn`. A visit is the unit; when we got
   *   round to asking about it is our business, not the client's.
   * - **NPS Responses** by `submittedAt`. The customer's own submission time, as
   *   her Google Form records it — `createdAt` is when the import ran, so a
   *   back-filled sheet would file three months of answers under one day.
   * - **Followup answers** by `submittedAt`, for the same reason.
   *
   * Neither bound means all time, which is what the client downloads today.
   *
   * ## The columns
   *
   * The Responses sheet is laid out from the tenant's configured format (see
   * `common/export-formats.ts`), defaulting to the client's own NPS Responses
   * tab. Updates and Followup answers keep their fixed shape: neither is a sheet
   * she maintains by hand, so there is nothing for a format to line up with.
   */
  async exportXlsx(user: AuthUser, opts: { storeId?: string; from?: string; to?: string } = {}) {
    /*
     * ## The zone, and why it is applied here rather than in the shared helper
     *
     * Every instant in this workbook is rendered — and every range bound is
     * resolved — as the BRANCH's own wall clock.
     *
     * The importer stores a sheet timestamp as the shop's wall clock (see
     * `parseNpsTimestamp`), so a submission the customer made at 09:00 IST is
     * held as 03:30 UTC. This export read both ends in UTC, which cost two
     * different things: every rendered time came out 5h30m early, so a row
     * compared against the Google Sheet it was reconciled with disagreed on
     * principle; and each day's window slid 5h30m earlier, so a 1 December
     * 04:00 IST submission landed inside a "to 30 November" file while a
     * 1 November 02:00 one fell out of "from 1 November".
     *
     * `resolveExportRange` keeps its UTC-day reading — leads, customers and
     * quotations are ranged through it and are not wall-clock data — so the
     * correction is local to this export.
     */
    const tz = await this.scope.resolveTimezone(user, opts.storeId);
    const utcDays = resolveExportRange(opts.from, opts.to);
    // Each UTC-midnight bound re-read as midnight AT THE BRANCH.
    const range: ExportRange = {
      from: utcDays.from ? instantFromLocalTime(utcDays.from, 0, tz) : undefined,
      to: utcDays.to ? instantFromLocalTime(utcDays.to, 0, tz) : undefined,
    };
    /*
     * `updates()` takes an INCLUSIVE upper bound (`lte` on `timeIn`), and the
     * resolved range's is exclusive. Handing it straight over would pull in a
     * visit stamped exactly midnight on the day after the range — one extra row,
     * on the one boundary somebody reconciles.
     */
    const page = {
      storeId: opts.storeId,
      from: range.from,
      to: range.to ? new Date(range.to.getTime() - 1) : undefined,
    };
    const { rows } = await this.updates(user, { ...page, take: 500 });
    const all = [...rows];
    let skip = rows.length;
    const total = (await this.updates(user, { ...page, take: 1 })).total;
    while (all.length < total && skip < 20000) {
      const next = await this.updates(user, { ...page, take: 500, skip });
      if (!next.rows.length) break;
      all.push(...next.rows);
      skip += 500;
    }

    const submitted = rangeWhere('submittedAt', range);
    const responses = await this.prisma.npsResponse.findMany({
      where: { organisationId: user.organisationId, ...submitted },
      orderBy: { submittedAt: 'desc' },
      take: 20000,
      include: {
        party: { select: { name: true } },
        checkIn: { select: { timeIn: true, store: { select: { name: true } } } },
      },
    });
    const followups = await this.prisma.npsFollowup.findMany({
      where: { organisationId: user.organisationId, ...submitted },
      orderBy: { submittedAt: 'desc' },
      take: 20000,
    });

    const org = await this.prisma.organisation.findUnique({
      where: { id: user.organisationId },
      select: { settings: true },
    });
    const responseFormat = readExportFormat(org?.settings, 'nps');

    const { Workbook } = await import('exceljs');
    const wb = new Workbook();
    const pad = (n: number) => String(n).padStart(2, '0');
    /**
     * An instant as the branch reads it off the wall, not as UTC. Every dated
     * cell in all three sheets goes through this one lambda — including
     * `followupDate`, which is a local midnight and so rendered the PREVIOUS
     * day under the old UTC slicing.
     */
    const local = (d: Date | null | undefined) => {
      if (!d) return '';
      const p = zonedParts(d, tz);
      return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
    };

    const ws = wb.addWorksheet('NPS Updates');
    ws.columns = [
      { header: 'Visit ID', key: 'checkInId', width: 26 },
      { header: 'Customer', key: 'customerName', width: 24 },
      { header: 'Phone', key: 'phone', width: 15 },
      { header: 'Store', key: 'store', width: 20 },
      { header: 'Visit date/time', key: 'visitAt', width: 18 },
      { header: 'Sales Person', key: 'salesperson', width: 18 },
      { header: 'Manager', key: 'manager', width: 18 },
      { header: 'Stage', key: 'stageLabel', width: 22 },
      { header: 'NPS Message Sent', key: 'initialSentAt', width: 18 },
      { header: 'Reminder due', key: 'reminderDueAt', width: 18 },
      { header: 'Reminder sent', key: 'reminderSentAt', width: 18 },
      { header: 'Customer replied', key: 'repliedAt', width: 18 },
      { header: 'NPS Response Received', key: 'submittedAt', width: 20 },
      { header: 'Score', key: 'score', width: 8 },
      { header: 'Followup', key: 'followup', width: 40 },
      { header: 'Failure', key: 'failureNote', width: 34 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of all) {
      ws.addRow({
        ...r,
        visitAt: local(r.visitAt),
        initialSentAt: local(r.initialSentAt),
        reminderDueAt: local(r.reminderDueAt),
        reminderSentAt: local(r.reminderSentAt),
        repliedAt: local(r.repliedAt),
        submittedAt: local(r.submittedAt),
        followup: r.followups.map((f) => `${local(f.date ?? f.at)}: ${f.response ?? ''}`).join(' | '),
      });
    }

    const rs = wb.addWorksheet('NPS Responses');
    rs.columns = responseFormat.map((c) => ({
      header: c.header,
      key: c.field,
      width: exportFieldWidth('nps', c.field),
    }));
    rs.getRow(1).font = { bold: true };
    for (const r of responses) {
      const row: Record<string, unknown> = {
        submittedAt: local(r.submittedAt),
        rawName: r.rawName ?? '',
        rawNumber: r.rawNumber ?? '',
        firstPurchase: r.firstPurchase ?? '',
        recommendAnswer: r.recommendAnswer ?? '',
        visitPurpose: r.visitPurpose ?? '',
        likedMost: r.likedMost ?? '',
        couldImprove: r.couldImprove ?? '',
        notFound: r.notFound ?? '',
        heardAboutUs: r.heardAboutUs ?? '',
        followsSocial: r.followsSocial ?? '',
        concerns: r.concerns ?? '',
        // Blank, not 0, when the answer never read as a number: a zero here is a
        // detractor, and inventing one would drag the average down.
        score: r.score ?? '',
        matchState: r.matchState,
        matchNote: r.matchNote ?? '',
        customer: r.party?.name ?? '',
        store: r.checkIn?.store?.name ?? '',
        visitAt: local(r.checkIn?.timeIn),
      };
      rs.addRow(Object.fromEntries(responseFormat.map((c) => [c.field, row[c.field] ?? ''])));
    }

    const fs = wb.addWorksheet('Followup answers');
    fs.columns = [
      { header: 'Timestamp', key: 'submittedAt', width: 18 },
      { header: 'Followup Date', key: 'followupDate', width: 16 },
      { header: 'Name', key: 'rawName', width: 22 },
      { header: 'Number', key: 'rawNumber', width: 15 },
      { header: 'Followup Response', key: 'response', width: 44 },
      { header: 'Match', key: 'matchState', width: 12 },
    ];
    fs.getRow(1).font = { bold: true };
    for (const f of followups) {
      fs.addRow({ ...f, submittedAt: local(f.submittedAt), followupDate: local(f.followupDate) });
    }

    addExportAboutSheet(wb, {
      what: 'NPS',
      // Three sheets, three columns — stated because a reader comparing the tabs
      // will otherwise assume one range was applied to one column.
      rangedOn: 'Visits by the day of the visit; responses by the day they were submitted',
      from: opts.from,
      to: opts.to,
      rows: all.length,
      notes: [
        ['Responses', String(responses.length)],
        ['Followup answers', String(followups.length)],
        // Named, because the About tab's "Taken" row is stamped in UTC and a
        // reader comparing the two must not read the rows as UTC as well.
        ['Times shown in', tz],
      ],
    });

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return {
      buffer,
      /*
       * The name says what is inside. Two of these on a desk with the same name
       * and different row counts is the next question we get asked — so a ranged
       * download carries its range, and an all-time one keeps the plain
       * day-stamped name it has always had.
       */
      filename:
        opts.from || opts.to
          ? rangeFilename('nps', opts.from, opts.to)
          : `nps-${new Date().toISOString().slice(0, 10)}.xlsx`,
      rows: all.length,
      responses: responses.length,
      followups: followups.length,
    };
  }
}
