import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';

import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { dateOnly, instantFromLocalTime, resolveTz, weekdayInTz } from '../common/tz.util';

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
 */

const DAY_MS = 86_400_000;

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
        role: { in: [Role.salesperson, Role.store_manager] },
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
      where: { id: { in: storeIds } },
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
    const staff = await this.prisma.user.findFirst({
      where: { id: input.userId, organisationId: user.organisationId },
      select: { id: true, name: true, userStores: { select: { storeId: true } } },
    });
    if (!staff) throw new NotFoundException('No such employee here.');

    const storeId = input.storeId ?? staff.userStores[0]?.storeId ?? null;
    if (storeId) this.scope.assertStoreAllowed(user, storeId);

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
      where: { id: storeId },
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
    const { start, end } = parsePeriod(input.periodKey);

    const staff = await this.prisma.user.findFirst({
      where: { id: input.userId, organisationId: user.organisationId },
      select: {
        id: true,
        name: true,
        userStores: { select: { storeId: true, isPrimary: true } },
      },
    });
    if (!staff) throw new NotFoundException('No such employee here.');

    const storeId =
      staff.userStores.find((s) => s.isPrimary)?.storeId ?? staff.userStores[0]?.storeId ?? null;
    if (storeId) this.scope.assertStoreAllowed(user, storeId);

    const existing = await this.prisma.payslip.findUnique({
      where: { userId_periodKey: { userId: staff.id, periodKey: input.periodKey } },
    });
    if (existing?.status === 'issued') {
      throw new BadRequestException(
        `${staff.name}'s ${input.periodKey} payslip has already been issued and cannot be regenerated.`,
      );
    }

    const comp = await this.prisma.staffCompensation.findUnique({ where: { userId: staff.id } });
    if (!comp) {
      throw new BadRequestException(
        `No pay is recorded for ${staff.name}. Record it before generating a payslip.`,
      );
    }

    const computed = await this.compute(staff.id, storeId, start, end, comp);

    const data = {
      organisationId: user.organisationId,
      userId: staff.id,
      storeId,
      periodKey: input.periodKey,
      periodStart: start,
      periodEnd: end,
      status: 'draft',
      ...computed.totals,
      breakdown: computed.days as unknown as Prisma.InputJsonValue,
    };
    const row = existing
      ? await this.prisma.payslip.update({ where: { id: existing.id }, data })
      : await this.prisma.payslip.create({ data });

    return this.view(row, staff.name);
  }

  /** Every employee in scope, for one month. Skips and reports the ones it cannot do. */
  async generateForStore(
    user: AuthUser,
    input: { storeId?: string; periodKey: string },
  ) {
    if (!PAYROLL_ROLES.includes(user.role)) {
      throw new ForbiddenException('Only a manager can generate payslips.');
    }
    const storeIds = this.scope.effectiveStoreIds(user, input.storeId);
    const staff = await this.prisma.user.findMany({
      where: {
        organisationId: user.organisationId,
        isActive: true,
        role: { in: [Role.salesperson, Role.store_manager] },
        userStores: { some: { storeId: { in: storeIds } } },
      },
      select: { id: true, name: true },
    });

    let generated = 0;
    const skipped: { name: string; reason: string }[] = [];
    for (const s of staff) {
      try {
        await this.generate(user, { userId: s.id, periodKey: input.periodKey });
        generated++;
      } catch (err) {
        // Reported by NAME, not counted. "3 skipped" tells a payroll clerk
        // nothing they can act on.
        skipped.push({
          name: s.name,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await this.audit.record(user, {
      action: 'hrms.payslips_generated',
      entityType: 'Payslip',
      entityId: input.periodKey,
      storeId: input.storeId ?? null,
      summary: `Generated ${generated} payslip(s) for ${input.periodKey}`,
      metadata: { generated, skipped: skipped.length },
    });
    return { periodKey: input.periodKey, generated, skipped };
  }

  /**
   * Count the month, from the attendance register.
   *
   * Every day of the period is classified, including days with no record at all —
   * a month where nobody punched must not silently produce a full month's pay.
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
    };
  }
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
