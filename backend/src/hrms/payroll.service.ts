import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PayrollRun, Payslip, Prisma, Role } from '@prisma/client';

import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  assertCanCorrect,
  assertMonthOpen,
  ROSTER_ROLES,
} from './attendance-ops.service';
import {
  businessDate,
  dateOnly,
  instantFromLocalTime,
  resolveTz,
  weekdayInTz,
  zonedParts,
} from '../common/tz.util';

/**
 * Weekly offs an employee actually has, and a payslip built from what the
 * attendance register says.
 *
 * ── The weekly off ──────────────────────────────────────────────────────────
 *
 * It used to be a property of the STORE: one day, everybody, every week. A shop
 * that does not close cannot work that way — the staff rotate, and marking a
 * whole branch off on Tuesday while half of it is on the floor makes the
 * register fiction and every figure computed from it wrong.
 *
 * Resolution is: the employee's own rows if they have any, else the store's day.
 * An employee with no rows behaves exactly as before, which is what makes this
 * deployable ahead of anybody building a roster.
 *
 * ── The payslip ─────────────────────────────────────────────────────────────
 *
 * Generated, then FROZEN. If it recomputed from live data a roster edited in
 * October would silently change September's slip, and the number the employee
 * was shown would no longer exist anywhere. A draft may be regenerated; an
 * issued one refuses.
 *
 * It is deliberately NOT statutory payroll. No tax, no PF, no ESI, no bank file.
 * It answers "how many days was this person paid for, and what does that come
 * to" — the question an attendance register can actually answer. Everything
 * needing a tax table is left to the accountant rather than approximated, and
 * the response says so.
 *
 * ── Month end ───────────────────────────────────────────────────────────────
 *
 * Once a branch's month has closed — at midnight WHERE THE BRANCH IS — the
 * scheduler drafts it and tells the branch's managers and head office. It only
 * ever drafts. Issuing is a person's act, and nothing here pays anybody.
 */

const DAY_MS = 86_400_000;

/**
 * How long after a branch's month closes the scheduler will still draft it.
 *
 * The window is what lets a missed tick, a restart or a deploy on the 1st still
 * catch the month. Its END is what stops a deploy on the 15th drafting a month
 * the business already paid by hand.
 */
export const MONTH_END_CATCH_UP_DAYS = 7;

/** Who may see somebody else's pay. Deliberately short. */
const PAYROLL_ROLES: Role[] = [Role.store_manager, Role.area_manager, Role.head_office];

export interface PayslipDay {
  date: string;
  /** 'present' | 'half' | 'absent' | 'leave' | 'week_off' | 'holiday' | 'no_record' */
  kind: string;
  credit: number;
  paid: boolean;
}

@Injectable()
export class PayrollService {
  private readonly log = new Logger(PayrollService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ==========================================================================
  // Weekly offs
  // ==========================================================================

  async weekOffsFor(user: AuthUser, storeId?: string) {
    const storeIds = this.scope.effectiveStoreIds(user, storeId);
    const staff = await this.prisma.user.findMany({
      where: {
        organisationId: user.organisationId,
        isActive: true,
        role: { in: [Role.salesperson, Role.storeperson, Role.store_manager] },
        userStores: { some: { storeId: { in: storeIds } } },
      },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        weekOffs: { where: { OR: [{ storeId: { in: storeIds } }, { storeId: null }] } },
        userStores: { select: { storeId: true, isPrimary: true } },
      },
    });
    const stores = await this.prisma.store.findMany({
      where: { id: { in: storeIds }, isHolding: false },
      select: { id: true, name: true, weekOffDay: true },
    });
    const storeById = new Map(stores.map((s) => [s.id, s]));

    return {
      /** The branch default, so the screen can say what "no rows" means. */
      stores: stores.map((s) => ({ id: s.id, name: s.name, weekOffDay: s.weekOffDay })),
      staff: staff.map((u) => {
        const primary =
          u.userStores.find((us) => us.isPrimary)?.storeId ?? u.userStores[0]?.storeId ?? null;
        const own = u.weekOffs.map((w) => w.dayOfWeek).sort();
        return {
          userId: u.id,
          name: u.name,
          storeId: primary,
          days: own,
          /** What actually applies — their own days, or the branch's. */
          effectiveDays: own.length
            ? own
            : primary && storeById.get(primary)?.weekOffDay != null
              ? [storeById.get(primary)!.weekOffDay!]
              : [],
          /** True when they are simply following the branch. */
          followsStore: own.length === 0,
        };
      }),
    };
  }

  async setWeekOffs(
    user: AuthUser,
    input: { userId: string; storeId?: string | null; days: number[] },
  ) {
    if (!PAYROLL_ROLES.includes(user.role)) {
      throw new ForbiddenException('Only a manager can configure weekly offs.');
    }
    const staff = await this.prisma.user.findFirst({
      where: { id: input.userId, organisationId: user.organisationId },
      select: { id: true, name: true, role: true, userStores: { select: { storeId: true } } },
    });
    if (!staff) throw new NotFoundException('No such employee here.');
    if (!ROSTER_ROLES.includes(staff.role)) {
      throw new BadRequestException('Weekly offs can only be configured for rostered staff.');
    }
    assertCanCorrect(user, staff.id, staff.role);

    const storeId = input.storeId ?? staff.userStores[0]?.storeId ?? null;
    if (!storeId) throw new BadRequestException('This employee is not assigned to a store.');
    this.scope.assertStoreAllowed(user, storeId);
    if (!staff.userStores.some((assignment) => assignment.storeId === storeId)) {
      throw new BadRequestException('Staff is not assigned to this store.');
    }
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, organisationId: user.organisationId, isHolding: false },
      select: { timezone: true },
    });
    if (!store) throw new NotFoundException('Store not found.');
    // A historical lock must not freeze the roster forever. This model applies
    // changes immediately, so only the current branch-local payroll month has
    // to be open; issued historical slips remain immutable.
    await assertMonthOpen(
      this.prisma,
      user.organisationId,
      businessDate(new Date(), resolveTz(store.timezone)),
    );

    const days = [...new Set(input.days)].sort();
    if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new BadRequestException('A weekly off must be a day of the week, 0 (Sunday) to 6.');
    }
    /*
     * Six days off is not a roster, it is a mistake nobody would notice until
     * payroll. Two is the realistic maximum a shop gives; three is where this
     * stops being a roster and starts being a data-entry error.
     */
    if (days.length > 3) {
      throw new BadRequestException('An employee cannot have more than three weekly offs.');
    }

    await this.prisma.$transaction([
      this.prisma.staffWeekOff.deleteMany({ where: { userId: staff.id, storeId } }),
      ...(days.length
        ? [
            this.prisma.staffWeekOff.createMany({
              data: days.map((dayOfWeek) => ({
                organisationId: user.organisationId,
                userId: staff.id,
                storeId,
                dayOfWeek,
                createdById: user.id,
              })),
            }),
          ]
        : []),
    ]);

    await this.audit.record(user, {
      action: 'hrms.week_off_set',
      entityType: 'StaffWeekOff',
      entityId: staff.id,
      storeId,
      summary: days.length
        ? `${staff.name} is off on ${days.map(dayName).join(', ')}`
        : `${staff.name} now follows the branch's weekly off`,
      metadata: { days },
    });
    return this.weekOffsFor(user, storeId ?? undefined);
  }

  /**
   * Which days of the week this employee is off, at this branch.
   *
   * Their own rows if they have any; otherwise the branch's single day. Returned
   * as a Set because the caller asks it once per day of the month.
   */
  async offDaysFor(userId: string, storeId: string | null): Promise<Set<number>> {
    const own = await this.prisma.staffWeekOff.findMany({
      where: { userId, ...(storeId ? { OR: [{ storeId }, { storeId: null }] } : {}) },
      select: { dayOfWeek: true },
    });
    if (own.length) return new Set(own.map((o) => o.dayOfWeek));
    if (!storeId) return new Set();
    const store = await this.prisma.store.findUnique({
      where: { id: storeId, isHolding: false },
      select: { weekOffDay: true },
    });
    return store?.weekOffDay != null ? new Set([store.weekOffDay]) : new Set();
  }

  // ==========================================================================
  // Compensation
  // ==========================================================================

  async setCompensation(
    user: AuthUser,
    input: {
      userId: string;
      basis?: string;
      amount: number;
      paidLeavePerMonth?: number | null;
      overtimeHourlyRate?: number | null;
    },
  ) {
    if (user.role !== Role.head_office) {
      throw new ForbiddenException('Only head office records what somebody is paid.');
    }
    const staff = await this.prisma.user.findFirst({
      where: { id: input.userId, organisationId: user.organisationId },
      select: { id: true, name: true },
    });
    if (!staff) throw new NotFoundException('No such employee here.');

    const basis = input.basis ?? 'monthly';
    if (basis !== 'monthly' && basis !== 'daily') {
      throw new BadRequestException('basis must be "monthly" or "daily".');
    }
    if (!(input.amount > 0) || input.amount > 99_999_999) {
      throw new BadRequestException('Give a pay amount greater than zero.');
    }

    const data = {
      basis,
      amount: new Prisma.Decimal(input.amount),
      paidLeavePerMonth:
        input.paidLeavePerMonth == null ? null : new Prisma.Decimal(input.paidLeavePerMonth),
      overtimeHourlyRate:
        input.overtimeHourlyRate == null ? null : new Prisma.Decimal(input.overtimeHourlyRate),
      updatedById: user.id,
    };
    const row = await this.prisma.staffCompensation.upsert({
      where: { userId: staff.id },
      create: { organisationId: user.organisationId, userId: staff.id, ...data },
      update: data,
    });

    await this.audit.record(user, {
      action: 'hrms.compensation_set',
      entityType: 'StaffCompensation',
      entityId: row.id,
      // Deliberately no amount in the summary: an audit list is read by people
      // who are not entitled to everybody's salary.
      summary: `Recorded ${staff.name}'s pay basis (${basis})`,
      metadata: { basis },
    });
    return this.compensationView(row);
  }

  async compensationFor(user: AuthUser, userId: string) {
    if (userId !== user.id && !PAYROLL_ROLES.includes(user.role)) {
      throw new ForbiddenException('You can only see your own pay.');
    }
    if (userId !== user.id && user.role !== Role.head_office) {
      const target = await this.prisma.user.findFirst({
        where: {
          id: userId,
          organisationId: user.organisationId,
          userStores: { some: { storeId: { in: user.storeIds } } },
        },
        select: { id: true },
      });
      // Do not disclose whether an out-of-scope employee or their compensation exists.
      if (!target) throw new NotFoundException('No such employee in your stores.');
    }
    const row = await this.prisma.staffCompensation.findFirst({
      where: { userId, organisationId: user.organisationId },
    });
    return row ? this.compensationView(row) : null;
  }

  private compensationView(row: {
    id: string;
    userId: string;
    basis: string;
    amount: Prisma.Decimal;
    paidLeavePerMonth: Prisma.Decimal | null;
    overtimeHourlyRate: Prisma.Decimal | null;
  }) {
    return {
      id: row.id,
      userId: row.userId,
      basis: row.basis,
      amount: Number(row.amount),
      paidLeavePerMonth: row.paidLeavePerMonth == null ? null : Number(row.paidLeavePerMonth),
      overtimeHourlyRate: row.overtimeHourlyRate == null ? null : Number(row.overtimeHourlyRate),
    };
  }

  // ==========================================================================
  // Payslips
  // ==========================================================================

  /**
   * Generate (or regenerate) one employee's slip for one month.
   *
   * Refuses to touch an ISSUED slip. That is the whole reliability story: once
   * an employee has been shown a number, it does not move because somebody
   * corrected a roster afterwards.
   */
  async generate(user: AuthUser, input: { userId: string; periodKey: string }) {
    if (!PAYROLL_ROLES.includes(user.role)) {
      throw new ForbiddenException('Only a manager can generate a payslip.');
    }
    const result = await this.draftOne(user, input.userId, input.periodKey);
    if (result.issued) {
      throw new BadRequestException(
        `${result.staffName}'s ${input.periodKey} payslip has already been issued and cannot be regenerated.`,
      );
    }
    return this.view(result.row, result.staffName);
  }

  /**
   * Every branch in scope, for one month. Skips and reports the ones it cannot do.
   *
   * Each branch goes through the same run the month-end scheduler uses, so a
   * person pressing "Generate" leaves the same record behind as the automatic
   * run does.
   */
  async generateForStore(
    user: AuthUser,
    input: { storeId?: string; periodKey: string },
  ) {
    if (!PAYROLL_ROLES.includes(user.role)) {
      throw new ForbiddenException('Only a manager can generate payslips.');
    }
    parsePeriod(input.periodKey);
    const storeIds = this.scope.effectiveStoreIds(user, input.storeId);
    const stores = await this.prisma.store.findMany({
      where: {
        id: { in: storeIds },
        organisationId: user.organisationId,
        isAggregate: false,
        isHolding: false,
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, organisationId: true },
    });

    let generated = 0;
    const skipped: { name: string; reason: string }[] = [];
    for (const store of stores) {
      const run = await this.runForStore(store, input.periodKey, user);
      if (!run) continue;
      generated += run.generated;
      // Reported by NAME, not counted. "3 skipped" tells a payroll clerk
      // nothing they can act on.
      skipped.push(...((run.skippedDetail as { name: string; reason: string }[] | null) ?? []));
      if (run.status === 'failed') {
        skipped.push({ name: store.name, reason: run.error ?? 'The run did not finish.' });
      }
    }
    return { periodKey: input.periodKey, generated, skipped };
  }

  /**
   * Draft one employee's slip for one month, or leave an issued one alone.
   *
   * The write is conditional on the row STILL being a draft, and Postgres
   * evaluates that condition — so a slip issued between the read and the write,
   * or a second run drafting the same person in the same instant, cannot be
   * overwritten. The unique (userId, periodKey) index is what stops two drafts;
   * a read-then-write could stop neither.
   *
   * An issued slip is recounted, never rewritten: if the register has moved
   * since, the slip is flagged (see {@link flagDifference}).
   */
  private async draftOne(
    actor: AuthUser,
    userId: string,
    periodKey: string,
  ): Promise<{ row: Payslip; staffName: string; issued: boolean; differs: boolean }> {
    const { start, end } = parsePeriod(periodKey);

    const staff = await this.prisma.user.findFirst({
      where: { id: userId, organisationId: actor.organisationId },
      select: {
        id: true,
        name: true,
        userStores: { select: { storeId: true, isPrimary: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!staff) throw new NotFoundException('No such employee here.');

    const storeId = primaryStoreOf(staff.userStores);
    if (storeId) this.scope.assertStoreAllowed(actor, storeId);

    const key = { userId_periodKey: { userId: staff.id, periodKey } };
    const leaveIssued = async (slip: Payslip) => ({
      row: slip,
      staffName: staff.name,
      issued: true,
      differs: await this.flagDifference(slip),
    });

    const existing = await this.prisma.payslip.findUnique({ where: key });
    if (existing?.status === 'issued') return leaveIssued(existing);

    const comp = await this.prisma.staffCompensation.findUnique({ where: { userId: staff.id } });
    if (!comp) {
      throw new BadRequestException(
        `No pay is recorded for ${staff.name}. Record it before generating a payslip.`,
      );
    }

    const computed = await this.compute(staff.id, storeId, start, end, comp);

    const data = {
      organisationId: actor.organisationId,
      userId: staff.id,
      storeId,
      periodKey,
      periodStart: start,
      periodEnd: end,
      status: 'draft',
      ...computed.totals,
      breakdown: computed.days as unknown as Prisma.InputJsonValue,
    };
    const overwriteDraft = () =>
      this.prisma.payslip.updateMany({
        where: { userId: staff.id, periodKey, status: 'draft' },
        data,
      });

    if ((await overwriteDraft()).count === 0) {
      try {
        await this.prisma.payslip.create({ data });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
          throw err;
        }
        // Somebody else wrote this slip between our read and our write. Still a
        // draft: ours replaces it. Issued in that instant: it stays as issued.
        if ((await overwriteDraft()).count === 0) {
          return leaveIssued(await this.prisma.payslip.findUniqueOrThrow({ where: key }));
        }
      }
    }

    const row = await this.prisma.payslip.findUniqueOrThrow({ where: key });
    return { row, staffName: staff.name, issued: false, differs: false };
  }

  /**
   * Count an issued slip's month again, and flag it if the register has moved.
   *
   * Only the ATTENDANCE is compared — day by day, and overtime. Pay is not
   * recomputed: a raise recorded in October is not a correction to September,
   * and turning a late correction into money (an arrear, a recovery) is the
   * business's decision, not one to invent here. The issued figures are never
   * written; only the flag beside them, and only when it actually changed, so a
   * run that finds nothing new leaves the row exactly as it was.
   */
  private async flagDifference(slip: Payslip): Promise<boolean> {
    const counted = await this.countDays(
      slip.userId,
      slip.storeId,
      slip.periodStart,
      slip.periodEnd,
    );
    const issuedDays = new Map(
      ((slip.breakdown as unknown as PayslipDay[] | null) ?? []).map((d) => [d.date, d]),
    );
    const days = counted.days.flatMap((now) => {
      const was = issuedDays.get(now.date);
      return was && was.kind === now.kind && was.credit === now.credit
        ? []
        : [
            {
              date: now.date,
              was: was ? { kind: was.kind, credit: was.credit } : null,
              now: { kind: now.kind, credit: now.credit },
            },
          ];
    });

    const difference =
      days.length || counted.overtimeMins !== slip.overtimeMins
        ? {
            days,
            presentDays: { was: Number(slip.presentDays), now: round2(counted.presentDays) },
            overtimeMins: { was: slip.overtimeMins, now: counted.overtimeMins },
          }
        : null;

    if (canonical(difference) !== canonical(slip.difference ?? null)) {
      await this.prisma.payslip.updateMany({
        where: { id: slip.id, status: 'issued' },
        data: {
          difference: difference ?? Prisma.DbNull,
          differenceDetectedAt: difference ? new Date() : null,
        },
      });
    }
    return difference != null;
  }

  /**
   * A correction to one day has landed. If that month was already issued to
   * this person, flag the slip now rather than wait for somebody to re-run.
   *
   * Best effort by contract: a correction must never fail because payroll could
   * not be recounted.
   */
  async recheckIssued(userId: string, date: Date): Promise<void> {
    try {
      const slip = await this.prisma.payslip.findFirst({
        where: { userId, periodKey: dateOnly(date).slice(0, 7), status: 'issued' },
      });
      if (slip) await this.flagDifference(slip);
    } catch (err) {
      this.log.warn(
        `Could not recheck an issued payslip after a correction: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Put a month's money on the day count.
   */
  private async compute(
    userId: string,
    storeId: string | null,
    start: Date,
    end: Date,
    comp: {
      basis: string;
      amount: Prisma.Decimal;
      paidLeavePerMonth: Prisma.Decimal | null;
      overtimeHourlyRate: Prisma.Decimal | null;
    },
  ) {
    const { days, presentDays, paidLeaveDays, unpaidDays, weeklyOffDays, holidayDays, overtimeMins } =
      await this.countDays(userId, storeId, start, end);

    const calendarDays = days.length;
    const amount = Number(comp.amount);
    const allowance = comp.paidLeavePerMonth == null ? 0 : Number(comp.paidLeavePerMonth);

    /*
     * Paid leave inside the allowance costs nothing; beyond it, it is unpaid.
     * Counted here rather than at classification time so the day-by-day
     * breakdown still shows WHICH days were leave.
     */
    const excessLeave = Math.max(0, paidLeaveDays - allowance);
    const chargeableUnpaid = round2(unpaidDays + excessLeave);

    let perDayRate: number;
    let earned: number;
    if (comp.basis === 'daily') {
      // Paid per day WORKED. Offs and holidays are not paid — which is the
      // difference between the two bases, and paying one as the other is a real
      // overpayment every month.
      perDayRate = amount;
      earned = round2(perDayRate * presentDays);
    } else {
      // A fixed monthly salary: offs, holidays and allowed leave are paid, and
      // unpaid absence is deducted at the month's own day rate.
      perDayRate = round2(amount / calendarDays);
      earned = round2(amount - perDayRate * chargeableUnpaid);
    }

    const otRate = comp.overtimeHourlyRate == null ? null : Number(comp.overtimeHourlyRate);
    const overtimeAmount = otRate == null ? 0 : round2((overtimeMins / 60) * otRate);

    return {
      days,
      totals: {
        calendarDays,
        weeklyOffDays,
        holidayDays,
        presentDays: new Prisma.Decimal(round2(presentDays)),
        paidLeaveDays: new Prisma.Decimal(round2(paidLeaveDays)),
        unpaidDays: new Prisma.Decimal(chargeableUnpaid),
        overtimeMins,
        basis: comp.basis,
        amount: new Prisma.Decimal(amount),
        perDayRate: new Prisma.Decimal(perDayRate),
        earnedAmount: new Prisma.Decimal(Math.max(0, earned)),
        overtimeAmount: new Prisma.Decimal(overtimeAmount),
        deductionAmount: new Prisma.Decimal(
          comp.basis === 'daily' ? 0 : round2(perDayRate * chargeableUnpaid),
        ),
        netPay: new Prisma.Decimal(round2(Math.max(0, earned) + overtimeAmount)),
      },
    };
  }

  /**
   * Count the month, from the attendance register.
   *
   * Every day of the period is classified, including days with no record at all —
   * a month where nobody punched must not silently produce a full month's pay.
   */
  private async countDays(userId: string, storeId: string | null, start: Date, end: Date) {
    const [records, holidays, offDays, store] = await Promise.all([
      this.prisma.attendanceRecord.findMany({
        where: { staffId: userId, date: { gte: start, lte: end } },
        select: {
          date: true, status: true, dayFraction: true, overtimeMins: true,
        },
      }),
      storeId
        ? this.prisma.storeHoliday.findMany({
            where: { storeId, date: { gte: start, lte: end } },
            select: { date: true },
          })
        : Promise.resolve([]),
      this.offDaysFor(userId, storeId),
      storeId
        ? this.prisma.store.findUnique({ where: { id: storeId }, select: { timezone: true } })
        : Promise.resolve(null),
    ]);

    const tz = resolveTz(store?.timezone);
    const byDate = new Map(records.map((r) => [dateOnly(r.date), r]));
    const holidayDates = new Set(holidays.map((h) => dateOnly(h.date)));

    const days: PayslipDay[] = [];
    let presentDays = 0;
    let paidLeaveDays = 0;
    let unpaidDays = 0;
    let weeklyOffDays = 0;
    let holidayDays = 0;
    let overtimeMins = 0;

    for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
      const day = new Date(t);
      const key = dateOnly(day);
      // Read at local NOON so the weekday is the branch's, clear of the offset.
      const weekday = weekdayInTz(instantFromLocalTime(day, 12 * 60, tz), tz);
      const record = byDate.get(key);
      const isHoliday = holidayDates.has(key);
      const isOff = offDays.has(weekday);

      if (record) {
        overtimeMins += record.overtimeMins ?? 0;
        const credit = record.dayFraction != null ? Number(record.dayFraction) : null;
        switch (record.status) {
          case 'week_off':
            weeklyOffDays++;
            days.push({ date: key, kind: 'week_off', credit: 0, paid: true });
            continue;
          case 'holiday':
            holidayDays++;
            days.push({ date: key, kind: 'holiday', credit: 0, paid: true });
            continue;
          case 'on_leave':
            paidLeaveDays++;
            days.push({ date: key, kind: 'leave', credit: 0, paid: true });
            continue;
          case 'absent':
            unpaidDays++;
            days.push({ date: key, kind: 'absent', credit: 0, paid: false });
            continue;
          default: {
            /*
             * dayFraction is what payroll consumes — `status` says "present"
             * for a half day too. Falling back to 1 when the fraction was never
             * computed is deliberate and stated: the person was at work, and
             * docking them for a field the system failed to fill is worse than
             * paying a full day.
             */
            const c = credit ?? 1;
            presentDays += c;
            if (c < 1) unpaidDays += 1 - c;
            days.push({
              date: key,
              kind: c >= 1 ? 'present' : 'half',
              credit: c,
              paid: true,
            });
            continue;
          }
        }
      }

      // No record at all.
      if (isHoliday) {
        holidayDays++;
        days.push({ date: key, kind: 'holiday', credit: 0, paid: true });
      } else if (isOff) {
        weeklyOffDays++;
        days.push({ date: key, kind: 'week_off', credit: 0, paid: true });
      } else {
        /*
         * A working day with nothing recorded is NOT quietly paid.
         *
         * Marked distinctly from `absent` so a payroll clerk can see the
         * difference between "the register says they did not come" and "the
         * register says nothing", which are different conversations.
         */
        unpaidDays++;
        days.push({ date: key, kind: 'no_record', credit: 0, paid: false });
      }
    }

    return { days, presentDays, paidLeaveDays, unpaidDays, weeklyOffDays, holidayDays, overtimeMins };
  }

  /** Issue it. After this the numbers are what the employee was shown. */
  async issue(user: AuthUser, payslipId: string) {
    if (!PAYROLL_ROLES.includes(user.role)) {
      throw new ForbiddenException('Only a manager can issue a payslip.');
    }
    const slip = await this.prisma.payslip.findFirst({
      where: { id: payslipId, ...this.scope.orgFilter(user) },
      include: { user: { select: { name: true } } },
    });
    if (!slip) throw new NotFoundException('No such payslip here.');
    if (slip.storeId) this.scope.assertStoreAllowed(user, slip.storeId);
    if (slip.status === 'issued') return this.view(slip, slip.user.name);

    const updated = await this.prisma.payslip.update({
      where: { id: slip.id },
      data: { status: 'issued', issuedAt: new Date(), issuedById: user.id },
    });
    await this.audit.record(user, {
      action: 'hrms.payslip_issued',
      entityType: 'Payslip',
      entityId: slip.id,
      storeId: slip.storeId,
      summary: `Issued ${slip.user.name}'s ${slip.periodKey} payslip`,
      metadata: { periodKey: slip.periodKey },
    });
    return this.view(updated, slip.user.name);
  }

  /**
   * Payslips for a month.
   *
   * An employee asking for their own always gets them; anybody else needs a
   * payroll role. Pay is the one thing in this product where "my manager can see
   * it" and "my colleague can see it" are genuinely different questions.
   */
  async list(user: AuthUser, opts: { periodKey?: string; userId?: string; storeId?: string } = {}) {
    const mine = opts.userId === user.id || (!opts.userId && !PAYROLL_ROLES.includes(user.role));
    if (!mine && !PAYROLL_ROLES.includes(user.role)) {
      throw new ForbiddenException('You can only see your own payslips.');
    }

    const rows = await this.prisma.payslip.findMany({
      where: {
        ...this.scope.orgFilter(user),
        ...(mine
          ? { userId: user.id }
          : {
              ...(opts.userId ? { userId: opts.userId } : {}),
              ...(opts.storeId
                ? { storeId: opts.storeId }
                : { OR: [{ storeId: { in: user.storeIds } }, { storeId: null }] }),
            }),
        ...(opts.periodKey ? { periodKey: opts.periodKey } : {}),
      },
      orderBy: [{ periodKey: 'desc' }],
      take: 200,
      include: { user: { select: { name: true } } },
    });
    return rows.map((r) => this.view(r, r.user.name));
  }

  async one(user: AuthUser, payslipId: string) {
    const slip = await this.prisma.payslip.findFirst({
      where: { id: payslipId, ...this.scope.orgFilter(user) },
      include: { user: { select: { name: true } } },
    });
    if (!slip) throw new NotFoundException('No such payslip here.');
    if (slip.userId !== user.id && !PAYROLL_ROLES.includes(user.role)) {
      throw new ForbiddenException('You can only see your own payslips.');
    }
    return { ...this.view(slip, slip.user.name), breakdown: slip.breakdown };
  }

  private view(
    r: {
      id: string; userId: string; storeId: string | null; periodKey: string;
      periodStart: Date; periodEnd: Date; status: string; issuedAt: Date | null;
      calendarDays: number; weeklyOffDays: number; holidayDays: number;
      presentDays: Prisma.Decimal; paidLeaveDays: Prisma.Decimal; unpaidDays: Prisma.Decimal;
      overtimeMins: number; basis: string; amount: Prisma.Decimal; perDayRate: Prisma.Decimal;
      earnedAmount: Prisma.Decimal; overtimeAmount: Prisma.Decimal;
      deductionAmount: Prisma.Decimal; netPay: Prisma.Decimal;
      difference: Prisma.JsonValue | null; differenceDetectedAt: Date | null;
    },
    staffName: string,
  ) {
    return {
      id: r.id,
      userId: r.userId,
      staffName,
      storeId: r.storeId,
      periodKey: r.periodKey,
      periodStart: dateOnly(r.periodStart),
      periodEnd: dateOnly(r.periodEnd),
      status: r.status,
      issuedAt: r.issuedAt,
      calendarDays: r.calendarDays,
      weeklyOffDays: r.weeklyOffDays,
      holidayDays: r.holidayDays,
      presentDays: Number(r.presentDays),
      paidLeaveDays: Number(r.paidLeaveDays),
      unpaidDays: Number(r.unpaidDays),
      overtimeMins: r.overtimeMins,
      basis: r.basis,
      amount: Number(r.amount),
      perDayRate: Number(r.perDayRate),
      earnedAmount: Number(r.earnedAmount),
      overtimeAmount: Number(r.overtimeAmount),
      deductionAmount: Number(r.deductionAmount),
      netPay: Number(r.netPay),
      /*
       * Said on every slip rather than in the documentation. A number labelled
       * "net pay" with no tax in it will otherwise be read as take-home, and the
       * person who finds out otherwise is the employee.
       */
      note: 'Before tax and statutory deductions. Computed from the attendance register.',
      /** Issued, and the register has moved since. The figures above stand. */
      difference: r.difference,
      differenceDetectedAt: r.differenceDetectedAt,
    };
  }

  // ==========================================================================
  // Month-end runs
  // ==========================================================================

  /**
   * Draft every branch whose month has just closed, where it is.
   *
   * Driven hourly by the scheduler; `now` is a parameter so the boundary can be
   * tested without a clock. A branch where nobody has pay recorded is passed
   * over: a tenant that does not use payroll gets no runs and no notifications,
   * rather than a monthly row saying nobody could be paid.
   */
  async sweepMonthEnd(now = new Date()): Promise<{ due: number; ran: number }> {
    const stores = await this.prisma.store.findMany({
      where: { isActive: true, isAggregate: false, isHolding: false },
      select: { id: true, name: true, timezone: true, organisationId: true },
    });
    let due = 0;
    let ran = 0;
    for (const store of stores) {
      const periodKey = closedPeriodAt(now, resolveTz(store.timezone));
      if (!periodKey) continue;
      // The cheap read first. After the first tick of the month every later one
      // finds the claim here instead of provoking a unique violation per branch
      // per hour. The unique index is still what decides a race.
      const claimed = await this.prisma.payrollRun.findUnique({
        where: { schedulerKey: schedulerKey(store.id, periodKey) },
        select: { id: true },
      });
      if (claimed) continue;
      const paid = await this.prisma.staffCompensation.count({
        where: {
          organisationId: store.organisationId,
          user: { isActive: true, userStores: { some: { storeId: store.id } } },
        },
      });
      if (!paid) continue;

      due++;
      try {
        if (await this.runForStore(store, periodKey, null)) ran++;
      } catch (err) {
        // One branch must not stop the others.
        this.log.error(
          `Month-end payroll for ${store.name} failed to start: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return { due, ran };
  }

  /**
   * A person running one branch's month: recovery for a failed or interrupted
   * run, or a recount after corrections. Always a new run record, always drafts.
   */
  async rerun(user: AuthUser, input: { storeId: string; periodKey: string }) {
    if (!PAYROLL_ROLES.includes(user.role)) {
      throw new ForbiddenException('Only a manager can run payroll.');
    }
    this.scope.assertStoreAllowed(user, input.storeId);
    const store = await this.prisma.store.findFirst({
      where: {
        id: input.storeId,
        organisationId: user.organisationId,
        isAggregate: false,
        isHolding: false,
      },
      select: { id: true, name: true, organisationId: true },
    });
    if (!store) throw new NotFoundException('No such branch here.');
    return this.runForStore(store, input.periodKey, user);
  }

  /** The run log a manager reads on the payroll screen. */
  async runs(user: AuthUser, opts: { periodKey?: string; storeId?: string } = {}) {
    if (!PAYROLL_ROLES.includes(user.role)) {
      throw new ForbiddenException('Only a manager can see payroll runs.');
    }
    return this.prisma.payrollRun.findMany({
      where: {
        organisationId: user.organisationId,
        storeId: { in: this.scope.effectiveStoreIds(user, opts.storeId) },
        ...(opts.periodKey ? { periodKey: opts.periodKey } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
  }

  /**
   * One branch, one month: claim, draft everybody whose slip lives here, record
   * what happened, and tell the people who review it.
   *
   * `by` null is the scheduler, whose claim is unique per branch-month. Returns
   * null when that claim already exists — the normal outcome of a retried or
   * concurrent tick, not an error. A person's run has no claim to lose.
   */
  private async runForStore(
    store: { id: string; name: string; organisationId: string },
    periodKey: string,
    by: AuthUser | null,
  ): Promise<PayrollRun | null> {
    parsePeriod(periodKey);

    let run: PayrollRun;
    try {
      run = await this.prisma.payrollRun.create({
        data: {
          organisationId: store.organisationId,
          storeId: store.id,
          periodKey,
          trigger: by ? 'user' : 'scheduler',
          triggeredById: by?.id ?? null,
          triggeredByName: by?.name ?? null,
          schedulerKey: by ? null : schedulerKey(store.id, periodKey),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
      throw err;
    }

    const actor = by ?? schedulerActor(store);
    let generated = 0;
    let issued = 0;
    let differences = 0;
    const skipped: { name: string; reason: string }[] = [];
    try {
      const staff = await this.prisma.user.findMany({
        where: {
          organisationId: store.organisationId,
          isActive: true,
          role: { in: [Role.salesperson, Role.storeperson, Role.store_manager] },
          userStores: { some: { storeId: store.id } },
        },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          userStores: { select: { storeId: true, isPrimary: true }, orderBy: { createdAt: 'asc' } },
        },
      });
      for (const s of staff) {
        // Drafted by the branch the slip belongs to, so somebody working two
        // branches is drafted once — not twice, and not refused by the other.
        if (primaryStoreOf(s.userStores) !== store.id) continue;
        try {
          const result = await this.draftOne(actor, s.id, periodKey);
          if (!result.issued) generated++;
          else {
            issued++;
            if (result.differs) differences++;
          }
        } catch (err) {
          skipped.push({ name: s.name, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      run = await this.prisma.payrollRun.update({
        where: { id: run.id },
        data: {
          status: 'completed',
          generated,
          issued,
          differences,
          skipped: skipped.length,
          skippedDetail: skipped,
          finishedAt: new Date(),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Payroll ${periodKey} for ${store.name} failed: ${message}`);
      run = await this.prisma.payrollRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          generated,
          issued,
          differences,
          skipped: skipped.length,
          skippedDetail: skipped,
          error: message.slice(0, 500),
          finishedAt: new Date(),
        },
      });
    }

    const audit = {
      action: by ? 'hrms.payroll_rerun' : 'hrms.payroll_month_end',
      entityType: 'PayrollRun',
      entityId: run.id,
      storeId: store.id,
      summary:
        run.status === 'failed'
          ? `${periodKey} payroll for ${store.name} did not finish`
          : `Drafted ${generated} payslip(s) for ${store.name}, ${periodKey}`,
      metadata: { periodKey, status: run.status, generated, skipped: skipped.length, issued, differences },
    };
    if (by) {
      await this.audit.record(by, audit);
    } else {
      await this.audit.recordSystem(store.organisationId, 'payroll_month_end', audit);
      await this.notifyReviewers(store, run);
    }
    return run;
  }

  /**
   * Tell the people who review this branch's payroll that it is waiting.
   *
   * Resolved by the same walk-up every approval uses — the branch's store and
   * area managers, and head office — so a salesperson never hears about
   * somebody else's pay. Nothing is said when nothing was drafted.
   */
  private async notifyReviewers(
    store: { id: string; name: string; organisationId: string },
    run: PayrollRun,
  ) {
    const failed = run.status === 'failed';
    if (!failed && run.generated === 0 && run.differences === 0) return;
    const month = periodLabel(run.periodKey);
    const summary = [
      `${run.generated} draft payslip(s)`,
      run.skipped ? `${run.skipped} could not be drafted` : null,
      run.differences ? `${run.differences} issued slip(s) no longer match the register` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    await this.notifications.emitToApprovers(
      store.id,
      Role.store_manager,
      {
        kind: 'system',
        title: failed
          ? `${month} payroll for ${store.name} did not finish`
          : `${month} payroll is ready for review — ${store.name}`,
        body: failed
          ? `${run.error ?? 'It stopped part-way.'} Re-run it from Roster and pay.`
          : `${summary}. Nothing has been issued.`,
        href: '/hrms/payroll',
        storeId: store.id,
        entityType: 'PayrollRun',
        entityId: run.id,
        priority: failed ? 'high' : 'normal',
        dedupeKey: `payroll-run:${store.id}:${run.periodKey}`,
      },
      undefined,
      store.organisationId,
    );
  }
}

/**
 * The month that has just closed at a branch, or null outside the catch-up window.
 *
 * Asked in the BRANCH's timezone: August closes at 00:00 on 1 September where
 * the staff are, not where the server is.
 */
export function closedPeriodAt(now: Date, tz: string): string | null {
  const p = zonedParts(now, tz);
  if (p.day > MONTH_END_CATCH_UP_DAYS) return null;
  // Month is 1-12; Date.UTC takes 0-11, so `p.month - 2` is the month before.
  const prev = new Date(Date.UTC(p.year, p.month - 2, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
}

function schedulerKey(storeId: string, periodKey: string): string {
  return `${storeId}:${periodKey}`;
}

/**
 * The principal a scheduled run drafts as: head office OF THAT TENANT, over that
 * one branch. The same shape the day-close uses — never global authority.
 */
function schedulerActor(store: { id: string; organisationId: string }): AuthUser {
  return {
    id: 'system-scheduler',
    name: 'CaratSense (automatic)',
    email: 'system@caratsense.local',
    role: Role.head_office,
    organisationId: store.organisationId,
    storeIds: [store.id],
    allStores: false,
  };
}

/**
 * The branch a person's payslip belongs to: their primary, else their earliest
 * assignment. Callers order `userStores` by creation so the answer is the same
 * from every query.
 */
function primaryStoreOf(stores: { storeId: string; isPrimary: boolean }[]): string | null {
  return stores.find((s) => s.isPrimary)?.storeId ?? stores[0]?.storeId ?? null;
}

/** '2026-08' → 'August 2026'. */
function periodLabel(periodKey: string): string {
  const { start } = parsePeriod(periodKey);
  return start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** JSON with sorted keys. Postgres reorders jsonb keys, so a plain stringify never compares equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** '2026-09' → the first and last day of that month, as `@db.Date` values. */
export function parsePeriod(periodKey: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(periodKey);
  if (!m) throw new BadRequestException('A period looks like 2026-09.');
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new BadRequestException('A period looks like 2026-09.');
  const start = new Date(Date.UTC(year, month - 1, 1));
  // Day 0 of the NEXT month is the last day of this one, leap years included.
  const end = new Date(Date.UTC(year, month, 0));
  return { start, end };
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function dayName(d: number): string {
  return DAY_NAMES[d] ?? String(d);
}

/** Money, to the paisa. Kept in one place so no two figures round differently. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
