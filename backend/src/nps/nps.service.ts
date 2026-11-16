import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuthUser } from '../common/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { NPS_STAGE_LABELS, NpsStage, npsReplyState, npsStage } from './nps-stage';
import {
  MatchCandidate,
  matchNpsResponse,
  normaliseNpsPhone,
  npsImportKey,
  parseRecommendScore,
} from './nps-match';

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
   * Ingest submissions.
   *
   * Historical rows are imported WITHOUT messaging anybody: this writes
   * responses and links them, and never creates or sends an ask. That is the
   * client's explicit instruction and also the only safe default — a bulk
   * import that messaged 1,900 historical walk-ins would be unrecoverable.
   *
   * Idempotent by `importKey`, so re-running the same sheet updates rather
   * than duplicates.
   */
  async importResponses(organisationId: string, rows: NpsResponseRow[]) {
    const summary = { received: rows.length, created: 0, updated: 0, matched: 0, ambiguous: 0, unmatched: 0 };

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

      const existing = await this.prisma.npsResponse.findUnique({ where: { importKey }, select: { id: true } });
      if (existing) {
        await this.prisma.npsResponse.update({ where: { importKey }, data });
        summary.updated++;
      } else {
        await this.prisma.npsResponse.create({ data: { ...data, importKey } });
        summary.created++;
      }
      summary[match.state === 'matched' ? 'matched' : match.state === 'ambiguous' ? 'ambiguous' : 'unmatched']++;

      if (match.state === 'matched' && match.checkInId) {
        await this.onMatched(organisationId, match.checkInId, row.submittedAt);
      }
    }
    return summary;
  }

  async importFollowups(organisationId: string, rows: NpsFollowupRow[]) {
    const summary = { received: rows.length, created: 0, updated: 0, matched: 0 };
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
      const existing = await this.prisma.npsFollowup.findUnique({ where: { importKey }, select: { id: true } });
      if (existing) {
        await this.prisma.npsFollowup.update({ where: { importKey }, data });
        summary.updated++;
      } else {
        await this.prisma.npsFollowup.create({ data: { ...data, importKey } });
        summary.created++;
      }
      if (match.state === 'matched') summary.matched++;
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
   */
  async exportXlsx(user: AuthUser, opts: { storeId?: string } = {}) {
    const { rows } = await this.updates(user, { storeId: opts.storeId, take: 500 });
    const all = [...rows];
    let skip = rows.length;
    const total = (await this.updates(user, { storeId: opts.storeId, take: 1 })).total;
    while (all.length < total && skip < 20000) {
      const page = await this.updates(user, { storeId: opts.storeId, take: 500, skip });
      if (!page.rows.length) break;
      all.push(...page.rows);
      skip += 500;
    }

    const responses = await this.prisma.npsResponse.findMany({
      where: { organisationId: user.organisationId },
      orderBy: { submittedAt: 'desc' },
      take: 20000,
    });
    const followups = await this.prisma.npsFollowup.findMany({
      where: { organisationId: user.organisationId },
      orderBy: { submittedAt: 'desc' },
      take: 20000,
    });

    const { Workbook } = await import('exceljs');
    const wb = new Workbook();
    const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') : '');

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
        visitAt: iso(r.visitAt),
        initialSentAt: iso(r.initialSentAt),
        reminderDueAt: iso(r.reminderDueAt),
        reminderSentAt: iso(r.reminderSentAt),
        repliedAt: iso(r.repliedAt),
        submittedAt: iso(r.submittedAt),
        followup: r.followups.map((f) => `${iso(f.date ?? f.at)}: ${f.response ?? ''}`).join(' | '),
      });
    }

    const rs = wb.addWorksheet('NPS Responses');
    rs.columns = [
      { header: 'Timestamp', key: 'submittedAt', width: 18 },
      { header: 'Name', key: 'rawName', width: 22 },
      { header: 'Number', key: 'rawNumber', width: 15 },
      { header: 'Is this your first purchase with Nibhana?', key: 'firstPurchase', width: 30 },
      { header: 'How likely are you to recommend Nibhana to your friends and family?', key: 'recommendAnswer', width: 34 },
      { header: 'What was the purpose of your visit?', key: 'visitPurpose', width: 30 },
      { header: 'What is the one thing you liked about our products and services?', key: 'likedMost', width: 34 },
      { header: 'What is the one thing we could improve to serve you better next time?', key: 'couldImprove', width: 34 },
      { header: "Was there any product you were searching for but didn't find in our store?", key: 'notFound', width: 34 },
      { header: 'How did you come to know about us?', key: 'heardAboutUs', width: 28 },
      { header: 'Do you follow our brand on social media?', key: 'followsSocial', width: 28 },
      { header: 'Kindly share your concerns or suggestions, if any', key: 'concerns', width: 34 },
      { header: 'Match', key: 'matchState', width: 12 },
      { header: 'Match note', key: 'matchNote', width: 40 },
    ];
    rs.getRow(1).font = { bold: true };
    for (const r of responses) rs.addRow({ ...r, submittedAt: iso(r.submittedAt) });

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
      fs.addRow({ ...f, submittedAt: iso(f.submittedAt), followupDate: iso(f.followupDate) });
    }

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return { buffer, rows: all.length, responses: responses.length, followups: followups.length };
  }
}
