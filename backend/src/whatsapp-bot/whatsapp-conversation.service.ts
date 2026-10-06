import { Injectable, Logger } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { StoreScopeService } from '../common/store-scope.service';
import { AuthUser } from '../common/auth-user';
import { businessDate, dateOnly, resolveTz } from '../common/tz.util';
import { NotificationsService } from '../notifications/notifications.service';
import {
  DRAFT_DATE_KEY,
  DSR_FIELDS,
  MAX_BACKDATE_DAYS,
  fillSkipped,
  formatDateLabel,
  isSkip,
  isoDate,
  nextAskableStep,
  parseField,
  parseReportDate,
  paymentSplitError,
  promptFor,
  sectionOf,
  summarise,
  type DsrDraft,
  type DsrField,
} from './dsr-flow';

/** An abandoned half-report must not resurface days later as if it were today. */
const SESSION_TTL_MS = 30 * 60 * 1000;

/** The user this conversation belongs to, as resolved from their linked number. */
export interface BotUser {
  id: string;
  name: string;
  role: Role;
  /** The user's tenant — every write and notification below is bounded to it. */
  organisationId: string;
}

const MENU = [
  'What would you like to do?',
  '',
  '*1* — Send a message to Head Office',
  '',
  'Reply with 1. Say *cancel* any time to stop.',
].join('\n');

/**
 * Where the questionnaire used to begin. The DSR now travels the other way:
 * staff file the day's figures on the dashboard, and this line delivers the
 * evening summary to head office. Anyone asking the old way is told the new
 * one rather than met with an unrecognised-option menu.
 */
const DSR_MOVED = [
  'Daily reports are filed on the *dashboard* now — open *Reporting & DSR* and use *Today’s DSR*.',
  '',
  'This number sends head office the evening summary once stores have filed.',
].join('\n');

/**
 * The guided conversation: the bot asks one field at a time and the user replies
 * with a value.
 *
 * Guided rather than parsing a pasted block (decided with the TL): a mis-read
 * number here lands in a revenue column and is only noticed at monthly close, so
 * every value is read from an answer to a known question, and the whole report is
 * played back for confirmation before a row is written.
 */
@Injectable()
export class WhatsAppConversationService {
  private readonly logger = new Logger(WhatsAppConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Handle one inbound message from a known user. Returns what to reply. */
  async handle(phoneE164: string, user: BotUser, rawText: string): Promise<string> {
    const text = (rawText ?? '').trim();
    const lower = text.toLowerCase();
    const session = await this.loadSession(phoneE164, user.id);

    if (['cancel', 'stop', 'exit'].includes(lower)) {
      await this.reset(phoneE164, user.id);
      return 'Cancelled — nothing was saved. Say *hi* to start again.';
    }
    if (['help', 'menu', 'hi', 'hello', 'start'].includes(lower)) {
      await this.reset(phoneE164, user.id);
      return `Hi ${user.name.split(' ')[0]} 👋\n\n${MENU}`;
    }

    switch (session.flow) {
      // A session caught mid-questionnaire when the flow was retired: told
      // where filing lives now, and the dangling session cleared.
      case 'pick_store':
      case 'dsr':
      case 'dsr_confirm': {
        await this.reset(phoneE164, user.id);
        return DSR_MOVED;
      }
      case 'message':
        return this.onMessage(phoneE164, user, session, text);
      default:
        return this.onIdle(phoneE164, user, lower);
    }
  }

  // ── idle ───────────────────────────────────────────────────────────────────

  private async onIdle(phoneE164: string, user: BotUser, lower: string): Promise<string> {
    if (['report', 'dsr', 'daily', 'daily report'].includes(lower)) {
      return DSR_MOVED;
    }
    if (['1', '2', 'message', 'msg'].includes(lower)) {
      await this.setSession(phoneE164, user.id, { flow: 'message', step: 0 });
      return 'What should I send to Head Office? Type your message.';
    }
    return MENU;
  }

  // ── daily report ───────────────────────────────────────────────────────────

  /**
   * Begin a report. A user attached to more than one branch is ASKED which —
   * silently defaulting to their primary store would file one branch's takings
   * against another, and the only clue would be a store name in a summary nobody
   * reads closely.
   */
  private async startDsr(phoneE164: string, user: BotUser): Promise<string> {
    const stores = await this.userStores(user);
    if (!stores.length) {
      return 'You are not assigned to a store yet, so I cannot file a report. Please ask your manager.';
    }
    if (stores.length > 1) {
      await this.setSession(phoneE164, user.id, { flow: 'pick_store', step: 0, draft: {} });
      const list = stores.map((s, i) => `*${i + 1}* — ${s.name}`).join('\n');
      return `Which store is this report for?\n\n${list}\n\nReply with the number.`;
    }
    return this.beginDsrFor(phoneE164, user, stores[0].id);
  }

  /** Store chosen (or the only one) — ask the first question. */
  private async beginDsrFor(
    phoneE164: string,
    user: BotUser,
    storeId: string,
  ): Promise<string> {
    const { label, date } = await this.storeContext(storeId);
    await this.setSession(phoneE164, user.id, {
      flow: 'dsr',
      step: 0,
      draft: { [DRAFT_DATE_KEY]: isoDate(date) },
      storeId,
    });
    // `askWithSection` with no previous field, so the opening question carries
    // its heading like every other section entry does.
    return (
      `Daily report for *${label}* — ${formatDateLabel(date)}.\n\n` +
      this.askWithSection(DSR_FIELDS[0], 0, {})
    );
  }

  private async onPickStore(phoneE164: string, user: BotUser, text: string): Promise<string> {
    const stores = await this.userStores(user);
    const choice = Number(text.trim());
    const picked =
      Number.isInteger(choice) && choice >= 1 && choice <= stores.length
        ? stores[choice - 1]
        : stores.find((s) => s.name.toLowerCase() === text.trim().toLowerCase());

    if (!picked) {
      const list = stores.map((s, i) => `*${i + 1}* — ${s.name}`).join('\n');
      return `I didn't recognise that. Reply with a number:\n\n${list}`;
    }
    return this.beginDsrFor(phoneE164, user, picked.id);
  }

  /**
   * The next question, with its sheet heading when the section changes.
   *
   * The heading is not decoration. "Of that — cash?" is asked twice, once for
   * the counter sale and once against bookings, and the store reconciles those
   * two tables separately — so a figure entered under the wrong heading is not
   * a rounding error, it is a number in the wrong column of a signed document.
   *
   * Announced on ENTRY to a section rather than repeated on every question,
   * which would turn a twenty-question report into a wall of headings.
   * `previous` is the field just answered, so the first question of the report
   * (no previous) also gets its heading.
   */
  private askWithSection(
    next: DsrField,
    nextStep: number,
    draft: DsrDraft,
    previous?: DsrField,
  ): string {
    const prompt = promptFor(next, nextStep, draft);
    const entering = sectionOf(next, nextStep);
    const leaving = previous ? sectionOf(previous, DSR_FIELDS.indexOf(previous)) : null;
    return entering && entering !== leaving ? `*${entering}*\n\n${prompt}` : prompt;
  }

  private async onDsrAnswer(
    phoneE164: string,
    user: BotUser,
    session: { step: number; draft: any; storeId: string | null },
    text: string,
  ): Promise<string> {
    const field = DSR_FIELDS[session.step];
    if (!field) return this.startDsr(phoneE164, user);

    const draft: DsrDraft = { ...(session.draft ?? {}) };

    if (isSkip(text)) {
      draft[field.key] = field.optional ? null : 0;
    } else {
      const value = parseField(field, text);
      if (value == null) {
        // Re-ask rather than store a guess.
        const what = field.kind === 'text' ? 'an answer' : 'a number';
        return `I couldn't read "${text}" as ${what}.\n\n${promptFor(field, session.step, draft)}`;
      }
      draft[field.key] = value;
    }

    /*
     * Refuse a split that exceeds its table's total, before it reaches the
     * summary.
     *
     * Checked on the LAST field of each split rather than per answer: cash on
     * its own being larger than the total is not yet a contradiction, because
     * the remaining modes could still be zero. It is the completed set that
     * has to reconcile. Re-asking the last question is the cheapest correction
     * that keeps the earlier answers.
     *
     * Each table is checked against its own total because the store
     * reconciles them separately — see `paymentSplitError`.
     */
    const closesSplit =
      field.key === 'oldGoldValue' || field.key === 'upi'
        ? ('A' as const)
        : field.key === 'customGoldValue' || field.key === 'customBankTransfer'
          ? ('B' as const)
          : null;
    if (closesSplit) {
      const complaint = paymentSplitError(draft, closesSplit);
      if (complaint) {
        return `${complaint}\n\n${promptFor(field, session.step, draft)}`;
      }
    }

    // Skip any question whose premise just failed, rather than asking it and
    // accepting an answer that contradicts the answer it depends on.
    const nextStep = nextAskableStep(draft, session.step + 1);
    if (nextStep < DSR_FIELDS.length) {
      await this.setSession(phoneE164, user.id, { flow: 'dsr', step: nextStep, draft });
      return this.askWithSection(DSR_FIELDS[nextStep], nextStep, draft, field);
    }

    // Everything the skip logic passed over still needs a value, or the report
    // carries nulls that read as missing rather than as a genuine zero.
    const complete = fillSkipped(draft);
    await this.setSession(phoneE164, user.id, { flow: 'dsr_confirm', step: nextStep, draft: complete });
    const { label } = await this.storeContext(session.storeId!);
    return summarise(complete, label, formatDateLabel(this.draftDate(complete)));
  }

  private async onDsrConfirm(
    phoneE164: string,
    user: BotUser,
    session: { draft: any; storeId: string | null },
    text: string,
  ): Promise<string> {
    const lower = text.trim().toLowerCase();
    const draft: Record<string, any> = { ...(session.draft ?? {}) };

    // "DATE 20/08" — correct the day before submitting. Without this a report
    // filed the morning after would silently overwrite today with yesterday's
    // numbers, and yesterday would never be recorded at all.
    if (lower.startsWith('date')) {
      const { label, date: today } = await this.storeContext(session.storeId!);
      const wanted = parseReportDate(lower.slice(4).trim(), today);
      if (!wanted) {
        return `I couldn't read that date. Send it like *DATE 20/08* — today or up to ${MAX_BACKDATE_DAYS} days back.`;
      }
      draft[DRAFT_DATE_KEY] = isoDate(wanted);
      await this.setSession(phoneE164, user.id, { flow: 'dsr_confirm', draft });
      return summarise(draft, label, formatDateLabel(wanted));
    }

    if (!['yes', 'y', 'ok', 'confirm', 'submit'].includes(lower)) {
      return 'Reply *YES* to submit, *CANCEL* to discard, or *DATE 20/08* to change the day.';
    }

    const saved = await this.saveDsr(user, session.storeId!, draft);
    await this.reset(phoneE164, user.id);
    const when = formatDateLabel(this.draftDate(draft));
    return saved.updated
      ? `✅ Updated the report for *${saved.storeName}* — ${when}. Head Office can see it.`
      : `✅ Report submitted for *${saved.storeName}* — ${when}. Head Office can see it. Thank you!`;
  }

  /** The date a draft is filed for; falls back to today if somehow absent. */
  private draftDate(draft: Record<string, any>): Date {
    const raw = draft?.[DRAFT_DATE_KEY];
    if (typeof raw === 'string') {
      const d = new Date(`${raw}T00:00:00.000Z`);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return businessDate(new Date(), resolveTz(null));
  }

  /**
   * Write the report and tell Head Office.
   *
   * Upsert on (storeId, reportDate): a manager who submits twice — or fixes a
   * number and resends — updates today's row instead of creating a second one
   * that would double every roll-up reading it.
   */
  private async saveDsr(user: BotUser, storeId: string, draft: Record<string, any>) {
    const actor = await this.asAuthUser(user);
    this.scope.assertStoreAllowed(actor, storeId);
    await this.scope.assertTradingStore(storeId);

    const store = await this.prisma.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { name: true, timezone: true },
    });
    // The day the user confirmed, not the day the message happened to arrive.
    const reportDate = this.draftDate(draft);
    const dec = (v: number | null | undefined) => new Prisma.Decimal(v ?? 0);

    const existing = await this.prisma.dailyReport.findUnique({
      where: { storeId_reportDate: { storeId, reportDate } },
      select: { id: true },
    });

    const count = (v: unknown) => (typeof v === 'number' ? v : 0);
    const wt = (v: unknown) => (typeof v === 'number' ? new Prisma.Decimal(v) : null);

    /*
     * Every column the sheet prints, not the handful the bot used to ask for.
     *
     * The questionnaire covered ten fields while the DSR sheet has around
     * twenty, so a WhatsApp-filed report arrived with conversions, open and
     * closed bookings, the whole customised-sale payment split and the remark
     * all sitting at their defaults — and a default zero is indistinguishable
     * from a counted zero once it is in the column. Head office was reading
     * those as real figures.
     */
    const data = {
      walkIns: count(draft.walkIns),
      seriousEnquiries: count(draft.seriousEnquiries),
      conversions: count(draft.conversions),

      // Table A — counter sale.
      deliveredBilled: dec(draft.deliveredBilled as number),
      cash: dec(draft.cash as number),
      card: dec(draft.card as number),
      upi: dec(draft.upi as number),
      oldGoldWtG: wt(draft.oldGoldWtG),
      oldGoldValue: wt(draft.oldGoldValue),

      // Table B — customised sale. Kept apart from Table A deliberately: the
      // store reconciles the two separately and a merged split cannot be
      // checked against either.
      bookingsNew: dec(draft.bookingsNew as number),
      bookingsOpen: dec(draft.bookingsOpen as number),
      bookingsClosed: dec(draft.bookingsClosed as number),
      advanceReceived: dec(draft.advanceReceived as number),
      customCash: dec(draft.customCash as number),
      customCard: dec(draft.customCard as number),
      customUpi: dec(draft.customUpi as number),
      customBankTransfer: dec(draft.customBankTransfer as number),
      customGoldWtG: wt(draft.customGoldWtG),
      customGoldValue: wt(draft.customGoldValue),

      // `bookingsClosing` is DERIVED by the reporting service and deliberately
      // not written here; a stored copy could disagree with the sheet.
      remark: typeof draft.remark === 'string' && draft.remark.trim() ? draft.remark.trim() : null,
      submittedBy: user.name,
      source: 'whatsapp',
    };

    const report = await this.prisma.dailyReport.upsert({
      where: { storeId_reportDate: { storeId, reportDate } },
      // Stamp the tenant on create; the store is already asserted in-scope above,
      // so this is the actor's own organisation.
      create: { organisationId: actor.organisationId, storeId, reportDate, ...data },
      update: data,
    });

    await this.audit.record(actor, {
      action: 'reporting.daily_submit',
      entityType: 'DailyReport',
      entityId: report.id,
      storeId,
      summary: `${user.name} submitted the daily report for ${store.name} over WhatsApp`,
      metadata: { source: 'whatsapp', updated: !!existing },
    });

    // Reaching Head Office IS the point of the feature — surface it in the bell.
    // Scoped to this store's organisation so only THIS tenant's HO is notified.
    const recipients = await this.notifications.recipientsFor(
      storeId,
      Role.head_office,
      user.id,
      actor.organisationId,
    );
    await this.notifications.emit(recipients, {
      kind: 'system',
      title: `Daily report — ${store.name}`,
      body: `${user.name} submitted today's report over WhatsApp.`,
      href: '/reporting',
      storeId,
      entityType: 'DailyReport',
      entityId: report.id,
      actorId: user.id,
      actorName: user.name,
      // Re-submitting the same day refreshes the notification instead of stacking.
      dedupeKey: `wa-dsr:${storeId}:${dateOnly(reportDate)}`,
    });

    return { storeName: store.name, updated: !!existing };
  }

  // ── store -> HO message ────────────────────────────────────────────────────

  /**
   * One-way by design (decided with the TL): the message lands in HO's
   * notification feed. HO does not reply through the bot.
   */
  private async onMessage(
    phoneE164: string,
    user: BotUser,
    _session: unknown,
    text: string,
  ): Promise<string> {
    if (!text) return 'Please type the message you want to send to Head Office.';

    const storeId = await this.resolveStoreId(user);
    const store = storeId
      ? await this.prisma.store.findUnique({ where: { id: storeId }, select: { name: true } })
      : null;

    // storeId may be null here (a user with no single branch), so the tenant is
    // passed explicitly — a store→HO message must still reach only this org's HO.
    const recipients = await this.notifications.recipientsFor(
      storeId ?? null,
      Role.head_office,
      user.id,
      user.organisationId,
    );
    await this.notifications.emit(recipients, {
      kind: 'system',
      title: `Message from ${store?.name ?? user.name}`,
      body: text.slice(0, 500),
      href: '/notifications',
      storeId: storeId ?? null,
      priority: 'high',
      actorId: user.id,
      actorName: user.name,
      metadata: { channel: 'whatsapp', from: phoneE164 },
    });

    await this.reset(phoneE164, user.id);
    return recipients.length
      ? '✅ Sent to Head Office. Say *hi* if you need anything else.'
      : '✅ Noted. (No Head Office user is set up to receive it yet.)';
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * Every real branch this user is attached to, primary first — bounded to the
   * user's own organisation so the store picker can never surface, or file
   * against, a branch in another tenant (defence-in-depth; the write is also
   * gated by assertStoreAllowed).
   */
  private async userStores(user: BotUser): Promise<{ id: string; name: string }[]> {
    const links = await this.prisma.userStore.findMany({
      where: {
        userId: user.id,
        store: { isAggregate: false, isActive: true, organisationId: user.organisationId },
      },
      orderBy: { isPrimary: 'desc' },
      select: { store: { select: { id: true, name: true } } },
    });
    return links.map((l) => l.store);
  }

  /** The single store a user files for, or null when it is ambiguous/none. */
  private async resolveStoreId(user: BotUser): Promise<string | null> {
    const stores = await this.userStores(user);
    return stores.length === 1 ? stores[0].id : (stores[0]?.id ?? null);
  }

  /**
   * Build the principal for the scope check. The bot must not invent its own
   * authorization — it goes through StoreScopeService exactly like the REST API,
   * INCLUDING the organisation: resolveScope bounds the store set to the user's
   * own tenant, and a missing organisation yields an empty scope (fail-closed),
   * never a global fetch.
   */
  private async asAuthUser(user: BotUser): Promise<AuthUser> {
    const organisationId = user.organisationId ?? '';
    const { storeIds, allStores } = await this.scope.resolveScope(
      user.id,
      user.role,
      organisationId,
    );
    return { id: user.id, name: user.name, email: '', role: user.role, organisationId, storeIds, allStores };
  }

  /** Store name plus what "today" is in that store's own timezone. */
  private async storeContext(storeId: string) {
    const store = await this.prisma.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { name: true, timezone: true },
    });
    const date = businessDate(new Date(), resolveTz(store.timezone));
    return { label: store.name, date, dateLabel: dateOnly(date) };
  }

  private async loadSession(phoneE164: string, userId: string) {
    const existing = await this.prisma.whatsAppSession.findUnique({ where: { phoneE164_kind: { phoneE164, kind: 'staff' } } });
    if (existing && existing.expiresAt > new Date() && existing.userId === userId) return existing;

    // Expired, missing, or belonging to a previous owner of this number.
    return this.prisma.whatsAppSession.upsert({
      where: { phoneE164_kind: { phoneE164, kind: 'staff' } },
      create: { phoneE164, userId, flow: 'idle', expiresAt: this.expiry() },
      update: { userId, flow: 'idle', step: 0, draft: Prisma.DbNull, storeId: null, expiresAt: this.expiry() },
    });
  }

  private async setSession(
    phoneE164: string,
    userId: string,
    patch: { flow: string; step?: number; draft?: any; storeId?: string },
  ) {
    await this.prisma.whatsAppSession.upsert({
      where: { phoneE164_kind: { phoneE164, kind: 'staff' } },
      create: {
        phoneE164,
        userId,
        flow: patch.flow,
        step: patch.step ?? 0,
        draft: patch.draft ?? Prisma.DbNull,
        storeId: patch.storeId ?? null,
        expiresAt: this.expiry(),
      },
      update: {
        userId,
        flow: patch.flow,
        ...(patch.step != null ? { step: patch.step } : {}),
        ...(patch.draft !== undefined ? { draft: patch.draft } : {}),
        ...(patch.storeId !== undefined ? { storeId: patch.storeId } : {}),
        expiresAt: this.expiry(),
      },
    });
  }

  private async reset(phoneE164: string, userId: string) {
    await this.setSession(phoneE164, userId, { flow: 'idle', step: 0, draft: Prisma.DbNull });
  }

  private expiry(): Date {
    return new Date(Date.now() + SESSION_TTL_MS);
  }
}
