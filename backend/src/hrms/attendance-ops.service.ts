import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AttendanceProcessingRun,
  AttendanceRecord,
  AttendanceStatus,
  PayrollPeriodLock,
  Prisma,
  RawPunchEvent,
  Role,
  Shift,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { AuditService } from '../common/audit.service';
import { ROLE_RANK } from '../common/role.util';
import {
  businessDate,
  computeDayFraction,
  computeEarlyOut,
  computeLateness,
  computeOvertime,
  dateOnly,
  formatHHMMInTz,
  instantFromLocalTime,
  parseHHMM,
  resolveTz,
  shiftDurationMins,
  weekdayInTz,
} from '../common/tz.util';
import type {
  CreatePunchDto,
  CreateShiftAssignmentDto,
  PunchesQueryDto,
  StartProcessingRunDto,
  UpdateHolidayDto,
  UpdateShiftAssignmentDto,
  UpdateShiftDto,
} from './dto/hrms.dto';

/*
 * Attendance operations (docs/modules/06-attendance.md, "Attendance operations").
 *
 * The free functions at the top are the SHARED rules — who counts on a date,
 * what one employee-day is, whether a month is open, which shift applies, how a
 * day is derived from its punches. Today, day-close, processing runs, the
 * register edits and the analytics reports all call these, so their numbers
 * cannot drift apart.
 */

type Db = PrismaService | Prisma.TransactionClient;

const DAY_MS = 86_400_000;

/** Roles that work a roster. HO / area managers see stores; they are not on them. */
export const ROSTER_ROLES: Role[] = [Role.salesperson, Role.storeperson, Role.store_manager];

/** Statuses that mean the person was at work. */
export const ATTENDED_STATUSES: AttendanceStatus[] = ['present', 'late', 'half_day'];

/** "YYYY-MM-DD" → the UTC-midnight Date a `@db.Date` column round-trips. */
export function parseYmd(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new BadRequestException(`Invalid date: ${s}`);
  }
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || dateOnly(d) !== s) {
    throw new BadRequestException(`Invalid date: ${s}`);
  }
  return d;
}

/**
 * Resolve a store-local date/time supplied by an operator into one UTC instant.
 *
 * A browser-created ISO string silently applies the browser's timezone, which
 * can put a manager correction on the wrong business day. The backend owns the
 * conversion because it owns the store timezone. DST gaps and folds are
 * rejected rather than guessed: payroll evidence must identify one instant.
 */
export function instantFromUnambiguousLocal(
  localDate: string,
  localTime: string,
  tz: string,
): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new BadRequestException('localDate must be YYYY-MM-DD');
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) {
    throw new BadRequestException('localTime must be HH:mm');
  }
  const zone = resolveTz(tz);
  const instant = instantFromLocalTime(parseYmd(localDate), parseHHMM(localTime), zone);
  const isSameWallClock = (candidate: Date) =>
    dateOnly(businessDate(candidate, zone)) === localDate &&
    formatHHMMInTz(candidate, zone) === localTime;

  if (!isSameWallClock(instant)) {
    throw new BadRequestException(
      `${localDate} ${localTime} does not exist in the store timezone (${zone})`,
    );
  }

  // A fall-back transition can map one wall-clock time to two instants. Check
  // the practical IANA transition sizes rather than silently choosing one.
  for (const minutes of [30, 60, 90, 120]) {
    if (
      isSameWallClock(new Date(instant.getTime() - minutes * 60_000)) ||
      isSameWallClock(new Date(instant.getTime() + minutes * 60_000))
    ) {
      throw new BadRequestException(
        `${localDate} ${localTime} is ambiguous in the store timezone (${zone}); use the legacy ISO instant with an explicit offset`,
      );
    }
  }
  return instant;
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

// ===========================================================================
// Who may correct whose attendance
// ===========================================================================

/**
 * No self or peer correction. Nobody marks, edits, deletes or punches their
 * own day, and below head office nobody does it for anyone at or above their
 * own rank (a store manager cannot fix a co-manager's day). Head office
 * corrects anyone but itself. Called after the target is loaded, beside the
 * store-scope check, in every correction path.
 */
export function assertCanCorrect(user: AuthUser, staffId: string, staffRole: Role): void {
  if (staffId === user.id) throw new ForbiddenException('You cannot correct your own attendance');
  if (user.role !== 'head_office' && ROLE_RANK[staffRole] >= ROLE_RANK[user.role]) {
    throw new ForbiddenException('You cannot correct the attendance of someone at or above your role');
  }
}

/** Load a target's role and apply {@link assertCanCorrect}. */
export async function assertCanCorrectUser(prisma: Db, user: AuthUser, staffId: string): Promise<void> {
  const target = await prisma.user.findFirst({
    where: { id: staffId, organisationId: user.organisationId },
    select: { role: true },
  });
  if (!target) throw new NotFoundException('Staff not found');
  assertCanCorrect(user, staffId, target.role);
}

// ===========================================================================
// Payroll locks
// ===========================================================================

/**
 * Refuse a write dated inside a locked payroll month (409). With `to`, every
 * month in [date, to] is checked — a leave spanning a locked month is refused.
 */
export async function assertMonthOpen(prisma: Db, orgId: string, date: Date, to?: Date): Promise<void> {
  const months = new Set<string>();
  const end = to && to > date ? to : date;
  for (let y = date.getUTCFullYear(), m = date.getUTCMonth(); ; m++) {
    const d = new Date(Date.UTC(y, m, 1));
    months.add(dateOnly(d).slice(0, 7));
    if (d.getUTCFullYear() > end.getUTCFullYear() || (d.getUTCFullYear() === end.getUTCFullYear() && d.getUTCMonth() >= end.getUTCMonth())) break;
  }
  const lock = await prisma.payrollPeriodLock.findFirst({
    where: { organisationId: orgId, month: { in: [...months] }, reopenedAt: null },
    select: { month: true },
  });
  if (lock) throw new ConflictException(`Payroll for ${lock.month} is locked`);
}

/** Refuse an effective-dated change whose old or new range touches a locked month. */
export async function assertEffectiveRangeOpen(
  prisma: Db,
  orgId: string,
  from: Date,
  to: Date | null,
): Promise<void> {
  const locks = await prisma.payrollPeriodLock.findMany({
    where: { organisationId: orgId, reopenedAt: null },
    select: { month: true },
  });
  const conflict = locks.find(({ month }) => {
    const [year, oneBasedMonth] = month.split('-').map(Number);
    const start = new Date(Date.UTC(year, oneBasedMonth - 1, 1));
    const end = new Date(Date.UTC(year, oneBasedMonth, 0));
    return from <= end && (to == null || to >= start);
  });
  if (conflict) throw new ConflictException(`Payroll for ${conflict.month} is locked`);
}

// ===========================================================================
// Eligibility + the one classification of an employee-day
// ===========================================================================

export type DayState =
  | 'present'
  | 'half_day'
  | 'absent'
  | 'on_leave'
  | 'week_off'
  | 'holiday'
  | 'not_marked';

export const DAY_STATES: DayState[] = [
  'present',
  'half_day',
  'absent',
  'on_leave',
  'week_off',
  'holiday',
  'not_marked',
];

/** One eligible (employee, store) pair on a date, with the day's non-punch facts resolved. */
export interface EligibleEmployee {
  userId: string;
  name: string;
  role: Role;
  storeId: string;
  storeName: string;
  timezone: string;
  isPrimary: boolean;
  employeeCode: string | null;
  department: { id: string; name: string } | null;
  designation: { id: string; name: string } | null;
  date: Date;
  /** An approved leave covers the date. */
  onLeave: boolean;
  /** The store declared the date a holiday. */
  isHoliday: boolean;
  /** Their own weekly off (StaffWeekOff), else the store's `weekOffDay`. */
  isWeekOff: boolean;
}

/**
 * Staff eligible at `storeIds` on business date `date`: one entry per
 * (employee, store) they belong to.
 *
 * Eligible = a roster role (salesperson / storeperson / store_manager — HO and
 * area managers are mapped to stores for visibility, not rostered), and:
 *  - with an EmployeeProfile: `status = active`, joined on/before the date (or
 *    no joining date) and not exited by it. The profile governs, not the login:
 *    an imported employee who has no app login yet still works shifts.
 *  - without a profile: `User.isActive` (the rule before the employee master).
 *
 * A person mapped to two of the requested stores appears once per store;
 * callers counting heads dedupe by `userId`.
 */
export async function eligibleStaff(
  prisma: Db,
  orgId: string,
  storeIds: string[],
  date: Date,
): Promise<EligibleEmployee[]> {
  if (storeIds.length === 0) return [];
  const links = await prisma.userStore.findMany({
    where: {
      storeId: { in: storeIds },
      store: { organisationId: orgId },
      user: {
        organisationId: orgId,
        role: { in: ROSTER_ROLES },
        OR: [
          { isActive: true, employeeProfile: { is: null } },
          {
            employeeProfile: {
              is: {
                status: 'active',
                AND: [
                  { OR: [{ dateOfJoining: null }, { dateOfJoining: { lte: date } }] },
                  { OR: [{ exitDate: null }, { exitDate: { gt: date } }] },
                ],
              },
            },
          },
        ],
      },
    },
    select: {
      storeId: true,
      isPrimary: true,
      store: { select: { name: true, timezone: true, weekOffDay: true } },
      user: {
        select: {
          id: true,
          name: true,
          role: true,
          employeeProfile: {
            select: {
              employeeCode: true,
              department: { select: { id: true, name: true } },
              designation: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  });
  if (links.length === 0) return [];
  const userIds = [...new Set(links.map((l) => l.user.id))];

  const [holidays, leaves, offs] = await Promise.all([
    prisma.storeHoliday.findMany({ where: { storeId: { in: storeIds }, date }, select: { storeId: true } }),
    prisma.leaveRequest.findMany({
      where: { staffId: { in: userIds }, status: 'approved', fromDate: { lte: date }, toDate: { gte: date } },
      select: { staffId: true },
    }),
    prisma.staffWeekOff.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, storeId: true, dayOfWeek: true },
    }),
  ]);
  const holidayStores = new Set(holidays.map((h) => h.storeId));
  const onLeave = new Set(leaves.map((l) => l.staffId));

  return links
    .map((l) => {
      const tz = resolveTz(l.store.timezone);
      // A @db.Date is a UTC-midnight stand-in: read its weekday at local noon.
      const weekday = weekdayInTz(instantFromLocalTime(date, 12 * 60, tz), tz);
      // Same rule as PayrollService.offDaysFor: their own rows (this store or
      // any store) REPLACE the branch's day; none → the branch's day.
      const own = offs.filter((o) => o.userId === l.user.id && (o.storeId === l.storeId || o.storeId === null));
      const isWeekOff = own.length
        ? own.some((o) => o.dayOfWeek === weekday)
        : l.store.weekOffDay != null && l.store.weekOffDay === weekday;
      const p = l.user.employeeProfile;
      return {
        userId: l.user.id,
        name: l.user.name,
        role: l.user.role,
        storeId: l.storeId,
        storeName: l.store.name,
        timezone: tz,
        isPrimary: l.isPrimary,
        employeeCode: p?.employeeCode ?? null,
        department: p?.department ?? null,
        designation: p?.designation ?? null,
        date,
        onLeave: onLeave.has(l.user.id),
        isHoliday: holidayStores.has(l.storeId),
        isWeekOff,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * THE single primary state of one employee-day. A register row wins (someone
 * or something decided the day); without one, approved leave > holiday >
 * weekly off > not yet marked. `isLate` is a modifier of `present`, never a
 * state of its own, so the seven states always sum to the headcount.
 */
export function classifyDay(
  facts: Pick<EligibleEmployee, 'onLeave' | 'isHoliday' | 'isWeekOff'>,
  record: Pick<AttendanceRecord, 'status' | 'isLate'> | null | undefined,
): { state: DayState; isLate: boolean } {
  if (record) {
    switch (record.status) {
      case 'present':
      case 'late':
        return { state: 'present', isLate: record.status === 'late' || !!record.isLate };
      case 'half_day':
        return { state: 'half_day', isLate: !!record.isLate };
      default:
        return { state: record.status, isLate: false };
    }
  }
  if (facts.onLeave) return { state: 'on_leave', isLate: false };
  if (facts.isHoliday) return { state: 'holiday', isLate: false };
  if (facts.isWeekOff) return { state: 'week_off', isLate: false };
  return { state: 'not_marked', isLate: false };
}

/**
 * Why an unpunched day at this location may NOT be recorded as "absent" yet;
 * empty = it may. No weekly off, no holidays and a 15-minute grace are all
 * valid settings, so "not configured" cannot be read from the data: HR states
 * the rules complete through a date (`attendanceRulesConfirmedThrough`). Until
 * that date covers the day, the day stays "not marked" for a human to decide.
 */
export async function absenceRuleGaps(prisma: Db, storeId: string, date: Date): Promise<string[]> {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { attendanceRulesConfirmedThrough: true, _count: { select: { shifts: true } } },
  });
  const gaps: string[] = [];
  const through = store?.attendanceRulesConfirmedThrough;
  if (!through) gaps.push('weekly offs, holidays and grace minutes not confirmed');
  else if (through < date) gaps.push(`rules confirmed only through ${dateOnly(through)}`);
  if (!store?._count.shifts) gaps.push('no shift set up');
  return gaps;
}

// ===========================================================================
// Shifts: effective-dated resolution + flexible-aware maths
// ===========================================================================

/**
 * The shift that applies: an explicit id (must be this store's), else the
 * ShiftAssignment effective on `date` whose shift belongs to this store, else
 * the store's earliest shift (the behaviour before assignments existed).
 */
export async function resolveShiftFor(
  prisma: Db,
  storeId: string,
  userId: string | null,
  date: Date | null,
  shiftId?: string | null,
): Promise<Shift | null> {
  if (shiftId) {
    const shift = await prisma.shift.findFirst({ where: { id: shiftId, storeId } });
    if (!shift) throw new NotFoundException('Shift not found for this store');
    return shift;
  }
  if (userId && date) {
    const assigned = await prisma.shiftAssignment.findMany({
      where: {
        userId,
        effectiveFrom: { lte: date },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }],
      },
      orderBy: { effectiveFrom: 'desc' },
      select: { shiftId: true },
    });
    if (assigned.length) {
      const shifts = await prisma.shift.findMany({
        where: { id: { in: assigned.map((a) => a.shiftId) }, storeId },
      });
      const hit = assigned.map((a) => shifts.find((s) => s.id === a.shiftId)).find(Boolean);
      if (hit) return hit;
    }
  }
  return prisma.shift.findFirst({ where: { storeId }, orderBy: { startTime: 'asc' } });
}

export type ShiftLike = Pick<Shift, 'startTime' | 'endTime' | 'bufferMins' | 'fullDayMins' | 'halfDayMins'> & {
  isFlexible?: boolean | null;
};

export const ATTENDANCE_CALCULATION_VERSION = '2026-09-18.v1';

/** Only calculation inputs are frozen; no employee or tenant data is duplicated. */
export function snapshotShift(
  shift: (ShiftLike & { id?: string | null }) | null,
): Prisma.InputJsonObject | undefined {
  if (!shift) return undefined;
  return {
    shiftId: shift.id ?? null,
    startTime: shift.startTime,
    endTime: shift.endTime,
    bufferMins: shift.bufferMins,
    fullDayMins: shift.fullDayMins ?? null,
    halfDayMins: shift.halfDayMins ?? null,
    isFlexible: shift.isFlexible ?? false,
  };
}

/** Read a previously frozen shift defensively; malformed legacy JSON falls back to live resolution. */
export function shiftFromSnapshot(value: Prisma.JsonValue | null | undefined): ShiftLike | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Prisma.JsonObject;
  if (
    typeof row.startTime !== 'string' ||
    typeof row.endTime !== 'string' ||
    typeof row.bufferMins !== 'number'
  ) {
    return null;
  }
  return {
    startTime: row.startTime,
    endTime: row.endTime,
    bufferMins: row.bufferMins,
    fullDayMins: typeof row.fullDayMins === 'number' ? row.fullDayMins : null,
    halfDayMins: typeof row.halfDayMins === 'number' ? row.halfDayMins : null,
    isFlexible: row.isFlexible === true,
  };
}

/** Lateness, never for a flexible shift (or with no shift). */
export function shiftLateness(checkInAt: Date, shift: ShiftLike | null, tz: string) {
  if (!shift || shift.isFlexible) return { isLate: false, lateMinutes: null as number | null };
  return computeLateness(checkInAt, shift, tz);
}

/** Early departure, never for a flexible shift. */
export function shiftEarlyOut(checkOutAt: Date, shift: ShiftLike | null, tz: string): number | null {
  if (!shift || shift.isFlexible) return null;
  return computeEarlyOut(checkOutAt, shift, tz);
}

/**
 * Day credit + overtime. A flexible shift's window (e.g. 05:00–23:00) is when
 * one MAY work, not a length to fill: without an explicit `fullDayMins` it is
 * measured like "no shift" rather than scoring a 9-hour day as a half.
 */
export function shiftDayMaths(workedMins: number | null, shift: ShiftLike | null) {
  const basis = shift && shift.isFlexible && shift.fullDayMins == null ? null : shift;
  return {
    dayFraction: computeDayFraction(workedMins, basis),
    overtimeMins: computeOvertime(workedMins, basis),
  };
}

// ===========================================================================
// The raw punch ledger
// ===========================================================================

export type PunchKind = 'in' | 'out';

export interface PunchInput {
  organisationId: string;
  userId: string;
  storeId: string;
  kind: PunchKind;
  eventAt: Date;
  /** self | manager | regularization | import | device | auto */
  source: string;
  idempotencyKey: string;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  note?: string | null;
  createdById?: string | null;
}

/** Append one punch. Replays of the same idempotency key are ignored. */
export async function recordPunch(prisma: Db, p: PunchInput): Promise<void> {
  await prisma.rawPunchEvent.createMany({
    data: [
      {
        organisationId: p.organisationId,
        userId: p.userId,
        storeId: p.storeId,
        kind: p.kind,
        eventAt: p.eventAt,
        source: p.source,
        idempotencyKey: p.idempotencyKey,
        lat: p.lat ?? null,
        lng: p.lng ?? null,
        accuracyM: p.accuracyM != null && Number.isFinite(p.accuracyM) ? Math.round(p.accuracyM) : null,
        note: p.note ?? null,
        createdById: p.createdById ?? null,
      },
    ],
    skipDuplicates: true,
  });
}

interface PunchLite {
  id: string;
  kind: string;
  eventAt: Date;
  source: string;
  voidedAt: Date | null;
}

/** A day's punches after attribution. */
export interface DayPunches {
  ins: PunchLite[];
  outs: PunchLite[];
}

/**
 * Attribute one person's non-voided punches (at one store) to business dates.
 *
 * An `in` belongs to its own local date. An `out` belongs to the latest date
 * whose FIRST in precedes it by under 24 h — so a night batch's 02:00 check-out
 * closes the shift it opened yesterday — else to its own local date (an
 * out-only day: a missed check-in).
 */
export function attributePunches(punches: PunchLite[], tz: string): Map<string, DayPunches> {
  const live = punches.filter((p) => !p.voidedAt).sort((a, b) => a.eventAt.getTime() - b.eventAt.getTime());
  const days = new Map<string, DayPunches>();
  const day = (k: string) => {
    let d = days.get(k);
    if (!d) days.set(k, (d = { ins: [], outs: [] }));
    return d;
  };
  const firstIn = new Map<string, Date>();
  for (const p of live) {
    if (p.kind !== 'in') continue;
    const k = dateOnly(businessDate(p.eventAt, tz));
    day(k).ins.push(p);
    if (!firstIn.has(k)) firstIn.set(k, p.eventAt);
  }
  const starts = [...firstIn.entries()].sort((a, b) => a[1].getTime() - b[1].getTime());
  for (const p of live) {
    if (p.kind !== 'out') continue;
    let owner: string | null = null;
    for (const [k, at] of starts) {
      if (at <= p.eventAt && p.eventAt.getTime() - at.getTime() < DAY_MS) owner = k;
    }
    day(owner ?? dateOnly(businessDate(p.eventAt, tz))).outs.push(p);
  }
  return days;
}

/** The register fields a day's punches imply. Pure. */
export function deriveFromPunches(day: DayPunches | undefined, shift: ShiftLike | null, tz: string) {
  const checkInAt = day?.ins[0]?.eventAt ?? null;
  const lastOut = day?.outs.length ? day.outs[day.outs.length - 1].eventAt : null;
  const checkOutAt = lastOut && (!checkInAt || lastOut > checkInAt) ? lastOut : null;
  const late = checkInAt ? shiftLateness(checkInAt, shift, tz) : { isLate: false, lateMinutes: null };
  const workedMins =
    checkInAt && checkOutAt ? Math.round((checkOutAt.getTime() - checkInAt.getTime()) / 60000) : null;
  const { dayFraction, overtimeMins } = shiftDayMaths(workedMins, shift);
  const status: AttendanceStatus =
    dayFraction != null && dayFraction < 1 ? 'half_day' : late.isLate ? 'late' : 'present';
  return {
    status,
    checkInAt,
    checkOutAt,
    isLate: late.isLate,
    lateMinutes: late.lateMinutes,
    workedMins,
    earlyOutMinutes: checkOutAt ? shiftEarlyOut(checkOutAt, shift, tz) : null,
    overtimeMins,
    dayFraction,
  };
}

/** Load one person's punches around a date (D-1 .. D+1) — enough to attribute D. */
async function punchesAround(prisma: Db, userId: string, storeId: string, date: Date, tz: string) {
  return prisma.rawPunchEvent.findMany({
    where: {
      userId,
      storeId,
      eventAt: {
        gte: instantFromLocalTime(addDays(date, -1), 0, tz),
        lt: instantFromLocalTime(addDays(date, 2), 0, tz),
      },
    },
    select: { id: true, kind: true, eventAt: true, source: true, voidedAt: true },
  });
}

/**
 * A register row whose times never reached the ledger (written before it
 * existed) gets them appended as punches — voided ones count as present, so a
 * deliberate void is never undone. Returns true when anything was appended.
 */
export async function seedLedgerFromRow(
  prisma: Db,
  orgId: string,
  row: Pick<AttendanceRecord, 'id' | 'staffId' | 'storeId' | 'date' | 'checkInAt' | 'checkOutAt' | 'source'>,
  tz: string,
  known?: PunchLite[],
): Promise<boolean> {
  if (!row.checkInAt && !row.checkOutAt) return false;
  const punches = known ?? (await punchesAround(prisma, row.staffId, row.storeId, row.date, tz));
  let seeded = false;
  for (const [kind, at] of [
    ['in', row.checkInAt],
    ['out', row.checkOutAt],
  ] as const) {
    if (!at || punches.some((p) => p.kind === kind && p.eventAt.getTime() === at.getTime())) continue;
    await recordPunch(prisma, {
      organisationId: orgId,
      userId: row.staffId,
      storeId: row.storeId,
      kind,
      eventAt: at,
      source: row.source,
      idempotencyKey: `backfill:${row.id}:${kind}:${at.toISOString()}`,
      note: 'Seeded from the register row (recorded before the punch ledger).',
    });
    seeded = true;
  }
  return seeded;
}

/**
 * Void the live punches of `kind` attributed to a day, because a human is
 * replacing them (manager edit, manager mark, approved regularization). The
 * rows stay as evidence; the day is then derived from the replacement.
 */
export async function supersedePunches(
  prisma: Db,
  opts: { userId: string; storeId: string; date: Date; tz: string; kinds: PunchKind[]; actorId: string | null },
): Promise<void> {
  const all = await punchesAround(prisma, opts.userId, opts.storeId, opts.date, opts.tz);
  const day = attributePunches(all, opts.tz).get(dateOnly(opts.date));
  if (!day) return;
  const ids = [
    ...(opts.kinds.includes('in') ? day.ins : []),
    ...(opts.kinds.includes('out') ? day.outs : []),
  ].map((p) => p.id);
  if (ids.length === 0) return;
  await prisma.rawPunchEvent.updateMany({
    where: { id: { in: ids }, voidedAt: null },
    data: { voidedAt: new Date(), voidedById: opts.actorId },
  });
}

// ===========================================================================
// View helpers shared with HrmsService
// ===========================================================================

export function toShiftView(s: Shift) {
  const scheduledMins = shiftDurationMins(s.startTime, s.endTime);
  return {
    id: s.id,
    storeId: s.storeId,
    name: s.name,
    code: s.code ?? null,
    startTime: s.startTime,
    endTime: s.endTime,
    bufferMins: s.bufferMins,
    isNightBatch: s.isNightBatch,
    isFlexible: s.isFlexible ?? false,
    scheduledMins,
    fullDayMins: s.fullDayMins ?? scheduledMins,
    halfDayMins: s.halfDayMins ?? Math.round((s.fullDayMins ?? scheduledMins) / 2),
    label: `${s.name} · ${s.isFlexible ? 'Flexible' : `${s.startTime}–${s.endTime}`}`,
  };
}

export function toHolidayView(h: { id: string; storeId: string; date: Date; label: string | null }) {
  return { id: h.id, storeId: h.storeId, date: dateOnly(h.date), label: h.label ?? null };
}

const REGISTER_FIELDS = [
  'status',
  'checkInAt',
  'checkOutAt',
  'isLate',
  'lateMinutes',
  'workedMins',
  'earlyOutMinutes',
  'overtimeMins',
  'dayFraction',
  'shiftId',
  'calculationVersion',
  'shiftSnapshot',
] as const;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return (a as Date | null)?.getTime?.() === (b as Date | null)?.getTime?.();
  }
  if (a != null && b != null && (typeof a === 'object' || typeof b === 'object')) {
    const an = Number(a);
    const bn = Number(b);
    if (!Number.isNaN(an) || !Number.isNaN(bn)) return an === bn; // Prisma.Decimal vs number
    return stableJson(a) === stableJson(b); // Shift snapshot JSON
  }
  return (a ?? null) === (b ?? null);
}

// ===========================================================================
// The service
// ===========================================================================

/** Today snapshot, raw punch ledger, processing runs, payroll locks, approvals, shift/holiday edits. */
@Injectable()
export class AttendanceOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
  ) {}

  private async stores(orgId: string, storeIds: string[]) {
    const rows = await this.prisma.store.findMany({
      where: { id: { in: storeIds }, organisationId: orgId, isHolding: false },
      select: { id: true, name: true, timezone: true },
      orderBy: { name: 'asc' },
    });
    return rows.map((s) => ({ id: s.id, name: s.name, tz: resolveTz(s.timezone) }));
  }

  // -------------------------------------------------------------------------
  // Recompute one employee-day from the ledger
  // -------------------------------------------------------------------------

  /**
   * Make the register row for one employee-day agree with the ledger. The ONE
   * implementation behind processing runs, punch add/void and the register edit,
   * so a correction and a later re-run can never disagree.
   *
   *  - Live punches → the times, lateness, credit and status are derived from
   *    them. A manager's half day with no out-punch stays a half day.
   *  - No live punches → a human non-attended mark (manager, import,
   *    regularization) stands; otherwise leave > holiday > weekly off > absent.
   *    Today with nothing yet stays unwritten (not marked).
   *  - A legacy row whose times never reached the ledger is seeded into it
   *    first (source kept), so history is not erased by the first run.
   *
   * Returns true when the row was created or changed. Never touches punches
   * except to append that seed.
   */
  async reprocessDay(args: {
    orgId: string;
    store: { id: string; tz: string };
    userId: string;
    staffName: string | null;
    date: Date;
    facts: Pick<EligibleEmployee, 'onLeave' | 'isHoliday' | 'isWeekOff'>;
    existing?: AttendanceRecord | null;
    punches?: PunchLite[];
    today?: Date;
    /** Transaction client when the ledger mutation and register rebuild are one operation. */
    prisma?: Db;
    /** `absenceRuleGaps` for this store/date, when the caller already has it. */
    ruleGaps?: string[];
  }): Promise<boolean> {
    const { orgId, store, userId, date } = args;
    const prisma = args.prisma ?? this.prisma;
    const tz = store.tz;
    const existing =
      args.existing !== undefined
        ? args.existing
        : await prisma.attendanceRecord.findUnique({
            where: { storeId_staffId_date: { storeId: store.id, staffId: userId, date } },
          });
    let punches = args.punches ?? (await punchesAround(prisma, userId, store.id, date, tz));

    // Seed a pre-ledger row's own times into the ledger (evidence first).
    if (existing && (await seedLedgerFromRow(prisma, orgId, existing, tz, punches))) {
      punches = await punchesAround(prisma, userId, store.id, date, tz);
    }

    const day = attributePunches(punches, tz).get(dateOnly(date));
    let data: Record<string, unknown>;
    let source = existing?.source ?? 'auto';

    if (day && (day.ins.length || day.outs.length)) {
      // A historical row is calculated from the frozen inputs it was born
      // with. Live shift edits must not rewrite payroll history on reprocess.
      const frozenShift = shiftFromSnapshot(existing?.shiftSnapshot);
      const liveShift = frozenShift
        ? null
        : existing?.shiftId
          ? await resolveShiftFor(prisma, store.id, null, null, existing.shiftId).catch(() => null)
          : await resolveShiftFor(prisma, store.id, userId, date);
      const shift = frozenShift ?? liveShift;
      const d = deriveFromPunches(day, shift, tz);
      if (!d.checkOutAt && existing?.status === 'half_day') {
        d.status = 'half_day';
        d.dayFraction = existing.dayFraction != null ? Number(existing.dayFraction) : 0.5;
      }
      data = {
        ...d,
        shiftId: existing?.shiftId ?? liveShift?.id ?? null,
        calculationVersion: existing?.calculationVersion ?? ATTENDANCE_CALCULATION_VERSION,
        shiftSnapshot: existing?.shiftSnapshot ?? snapshotShift(liveShift),
      };
      if (!existing) source = (day.ins[0] ?? day.outs[0]).source;
    } else {
      if (existing && existing.source !== 'auto' && !ATTENDED_STATUSES.includes(existing.status)) {
        return false;
      }
      const today = args.today ?? businessDate(new Date(), tz);
      if (date.getTime() >= today.getTime() && !existing) return false;
      const st = classifyDay(args.facts, null).state;
      if (st === 'not_marked' && (args.ruleGaps ?? (await absenceRuleGaps(prisma, store.id, date))).length) {
        // Rules unconfirmed: the day stays "not marked". The app's own earlier
        // inference is withdrawn; a human's row is left as they set it.
        if (existing?.source !== 'auto') return false;
        await prisma.attendanceRecord.delete({ where: { id: existing.id } });
        return true;
      }
      const status: AttendanceStatus = st === 'not_marked' ? 'absent' : st;
      data = {
        status,
        checkInAt: null,
        checkOutAt: null,
        isLate: false,
        lateMinutes: null,
        workedMins: null,
        earlyOutMinutes: null,
        overtimeMins: null,
        dayFraction: status === 'absent' ? 0 : null,
        shiftId: existing?.shiftId ?? null,
        calculationVersion: existing?.calculationVersion ?? ATTENDANCE_CALCULATION_VERSION,
        shiftSnapshot: existing?.shiftSnapshot ?? undefined,
      };
    }

    if (existing) {
      if (REGISTER_FIELDS.every((k) => sameValue((existing as any)[k], data[k]))) return false;
      await prisma.attendanceRecord.update({ where: { id: existing.id }, data: data as any });
      return true;
    }
    await prisma.attendanceRecord.create({
      data: {
        organisationId: orgId,
        storeId: store.id,
        staffId: userId,
        staffName: args.staffName,
        date,
        source,
        ...(data as any),
      },
    });
    return true;
  }

  /** Recompute one employee-day with its facts resolved (after a punch add/void). */
  private async reprocessOne(
    orgId: string,
    storeId: string,
    userId: string,
    date: Date,
    prisma: Db = this.prisma,
  ) {
    const storeRow = await prisma.store.findFirst({
      where: { id: storeId, organisationId: orgId, isHolding: false },
      select: { id: true, timezone: true },
    });
    if (!storeRow) throw new NotFoundException('Store not found');
    const store = { id: storeRow.id, tz: resolveTz(storeRow.timezone) };
    const e = (await eligibleStaff(prisma, orgId, [storeId], date)).find(
      (x) => x.userId === userId,
    );
    const target = e
      ? null
      : await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    await this.reprocessDay({
      orgId,
      store,
      userId,
      staffName: e?.name ?? target?.name ?? null,
      date,
      facts: e ?? { onLeave: false, isHoliday: false, isWeekOff: false },
      prisma,
    });
  }

  // -------------------------------------------------------------------------
  // Today
  // -------------------------------------------------------------------------

  /** GET /hrms/attendance/today — one primary state per eligible employee. */
  async today(user: AuthUser, storeId?: string) {
    const storeIds = this.scope.effectiveStoreIds(user, storeId);
    const stores = await this.stores(user.organisationId, storeIds);
    const now = new Date();
    const dateOf = new Map(stores.map((s) => [s.id, businessDate(now, s.tz)]));

    // Eligibility per distinct business date (one, unless stores span zones).
    const byDate = new Map<string, string[]>();
    for (const s of stores) {
      const k = dateOnly(dateOf.get(s.id)!);
      byDate.set(k, [...(byDate.get(k) ?? []), s.id]);
    }
    const eligible = (
      await Promise.all(
        [...byDate.entries()].map(([d, ids]) => eligibleStaff(this.prisma, user.organisationId, ids, parseYmd(d))),
      )
    ).flat();

    const records = await this.prisma.attendanceRecord.findMany({
      where: {
        OR: stores.map((s) => ({ storeId: s.id, date: dateOf.get(s.id)! })),
        staffId: { in: [...new Set(eligible.map((e) => e.userId))] },
      },
    });
    const recordAt = new Map(records.map((r) => [`${r.staffId}|${r.storeId}`, r]));

    // One person, one row: the store where they have a record, else primary, else first.
    const chosen = new Map<string, EligibleEmployee>();
    for (const e of eligible) {
      const cur = chosen.get(e.userId);
      const score = (x: EligibleEmployee) => (recordAt.has(`${x.userId}|${x.storeId}`) ? 2 : 0) + (x.isPrimary ? 1 : 0);
      if (!cur || score(e) > score(cur)) chosen.set(e.userId, e);
    }

    const shiftIds = [...new Set(records.map((r) => r.shiftId).filter(Boolean))] as string[];
    const shifts = shiftIds.length ? await this.prisma.shift.findMany({ where: { id: { in: shiftIds } } }) : [];
    const shiftById = new Map(shifts.map((s) => [s.id, s]));

    const counts = { present: 0, late: 0, half_day: 0, absent: 0, on_leave: 0, week_off: 0, holiday: 0, not_marked: 0 };
    const rows = [...chosen.values()].map((e) => {
      const r = recordAt.get(`${e.userId}|${e.storeId}`) ?? null;
      const { state, isLate } = classifyDay(e, r);
      counts[state]++;
      if (isLate) counts.late++;
      const shift = r?.shiftId ? shiftById.get(r.shiftId) : null;
      return {
        userId: e.userId,
        employeeCode: e.employeeCode,
        name: e.name,
        storeId: e.storeId,
        storeName: e.storeName,
        department: e.department,
        designation: e.designation,
        shift: shift ? { id: shift.id, name: shift.name, startTime: shift.startTime, endTime: shift.endTime } : null,
        state,
        isLate,
        lateMinutes: r?.lateMinutes ?? null,
        checkIn: formatHHMMInTz(r?.checkInAt, e.timezone),
        checkOut: formatHHMMInTz(r?.checkOutAt, e.timezone),
        recordId: r?.id ?? null,
      };
    });

    return {
      snapshotAt: now.toISOString(),
      stores: stores.map((s) => ({ storeId: s.id, storeName: s.name, timezone: s.tz, date: dateOnly(dateOf.get(s.id)!) })),
      denominator: rows.length,
      counts,
      rows,
    };
  }

  // -------------------------------------------------------------------------
  // Raw punches
  // -------------------------------------------------------------------------

  /** GET /hrms/punches — the ledger, store-scoped. Default window: the last 7 days. */
  async punches(user: AuthUser, q: PunchesQueryDto) {
    const storeIds = this.scope.effectiveStoreIds(user, q.storeId);
    const stores = await this.stores(user.organisationId, storeIds);
    const tz = stores[0]?.tz ?? resolveTz(undefined);
    const to = q.to ? parseYmd(q.to) : businessDate(new Date(), tz);
    const from = q.from ? parseYmd(q.from) : addDays(to, -6);
    if (to < from) throw new BadRequestException('`to` must be on or after `from`');
    if ((to.getTime() - from.getTime()) / DAY_MS > 92) throw new BadRequestException('Date range too large (max 93 days)');

    const rows = await this.prisma.rawPunchEvent.findMany({
      where: {
        organisationId: user.organisationId,
        storeId: { in: storeIds },
        ...(q.userId ? { userId: q.userId } : {}),
        eventAt: { gte: instantFromLocalTime(from, 0, tz), lt: instantFromLocalTime(addDays(to, 1), 0, tz) },
      },
      orderBy: { eventAt: 'desc' },
      take: 5000,
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
      select: { id: true, name: true, employeeProfile: { select: { employeeCode: true } } },
    });
    const userById = new Map(users.map((u) => [u.id, u]));
    const storeById = new Map(stores.map((s) => [s.id, s]));
    return rows.map((r) => this.toPunchView(r, userById.get(r.userId), storeById.get(r.storeId ?? '')));
  }

  private toPunchView(
    r: RawPunchEvent,
    u: { name: string; employeeProfile: { employeeCode: string } | null } | undefined,
    s: { name: string; tz: string } | undefined,
  ) {
    return {
      id: r.id,
      userId: r.userId,
      name: u?.name ?? r.userId,
      employeeCode: u?.employeeProfile?.employeeCode ?? null,
      storeId: r.storeId,
      storeName: s?.name ?? null,
      kind: r.kind,
      eventAt: r.eventAt.toISOString(),
      local: formatHHMMInTz(r.eventAt, s?.tz ?? resolveTz(undefined)),
      date: dateOnly(businessDate(r.eventAt, s?.tz ?? resolveTz(undefined))),
      source: r.source,
      lat: r.lat != null ? Number(r.lat) : null,
      lng: r.lng != null ? Number(r.lng) : null,
      accuracyM: r.accuracyM ?? null,
      note: r.note ?? null,
      voidedAt: r.voidedAt ? r.voidedAt.toISOString() : null,
    };
  }

  /** POST /hrms/punches — a manager records a missing dashboard punch. */
  async addPunch(user: AuthUser, dto: CreatePunchDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);
    const [store] = await this.stores(user.organisationId, [dto.storeId]);
    if (!store) throw new NotFoundException('Store not found');
    const member = await this.prisma.userStore.findFirst({
      where: { userId: dto.userId, storeId: dto.storeId, user: { organisationId: user.organisationId } },
      include: { user: { select: { name: true, role: true } } },
    });
    if (!member) throw new BadRequestException('Staff is not assigned to this store');
    assertCanCorrect(user, dto.userId, member.user.role);
    const hasInstant = dto.at != null;
    const hasAnyLocalPart = dto.localDate != null || dto.localTime != null;
    if (hasInstant === hasAnyLocalPart) {
      throw new BadRequestException(
        'Send exactly one punch-time form: either `at`, or `localDate` with `localTime`.',
      );
    }
    if (hasAnyLocalPart && (!dto.localDate || !dto.localTime)) {
      throw new BadRequestException('Both `localDate` and `localTime` are required together.');
    }
    const at = dto.at
      ? new Date(dto.at)
      : instantFromUnambiguousLocal(dto.localDate!, dto.localTime!, store.tz);
    if (Number.isNaN(at.getTime())) throw new BadRequestException('Invalid punch time');
    if (at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('A punch cannot be in the future');
    const date = businessDate(at, store.tz);
    await assertMonthOpen(this.prisma, user.organisationId, date);

    const key = `manager:${dto.userId}:${dto.storeId}:${dto.kind}:${at.toISOString()}`;
    const row = await this.prisma.$transaction(async (tx) => {
      await recordPunch(tx, {
        organisationId: user.organisationId,
        userId: dto.userId,
        storeId: dto.storeId,
        kind: dto.kind,
        eventAt: at,
        source: 'manager',
        idempotencyKey: key,
        note: dto.note.trim(),
        createdById: user.id,
      });
      const saved = await tx.rawPunchEvent.findUniqueOrThrow({
        where: {
          organisationId_idempotencyKey: {
            organisationId: user.organisationId,
            idempotencyKey: key,
          },
        },
      });
      await this.reprocessOne(
        user.organisationId,
        dto.storeId,
        dto.userId,
        date,
        tx,
      );
      return saved;
    });
    await this.audit.record(user, {
      action: 'attendance.punch_add',
      entityType: 'RawPunchEvent',
      entityId: row.id,
      storeId: dto.storeId,
      summary: `Added a ${dto.kind} punch for ${member.user.name} at ${formatHHMMInTz(at, store.tz)} on ${dateOnly(date)}`,
      metadata: { after: { userId: dto.userId, kind: dto.kind, eventAt: at.toISOString(), note: dto.note } },
    });
    return this.toPunchView(row, { name: member.user.name, employeeProfile: null }, store);
  }

  /** DELETE /hrms/punches/:id — void (never delete) and recompute that day. */
  async voidPunch(user: AuthUser, id: string, reason?: string) {
    const row = await this.prisma.rawPunchEvent.findFirst({
      where: { id, organisationId: user.organisationId, storeId: { in: user.storeIds } },
    });
    if (!row || !row.storeId) throw new NotFoundException('Punch not found');
    if (row.voidedAt) throw new BadRequestException('This punch is already void');
    await assertCanCorrectUser(this.prisma, user, row.userId);
    const [store] = await this.stores(user.organisationId, [row.storeId]);
    // The day it counts toward — for a night out-punch, the shift's start day.
    const all = await punchesAround(this.prisma, row.userId, row.storeId, businessDate(row.eventAt, store.tz), store.tz);
    let date = businessDate(row.eventAt, store.tz);
    for (const [k, d] of attributePunches(all, store.tz)) {
      if ([...d.ins, ...d.outs].some((p) => p.id === row.id)) date = parseYmd(k);
    }
    await assertMonthOpen(this.prisma, user.organisationId, date);

    const voided = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.rawPunchEvent.update({
        where: { id },
        data: { voidedAt: new Date(), voidedById: user.id },
      });
      await this.reprocessOne(user.organisationId, row.storeId!, row.userId, date, tx);
      return saved;
    });
    await this.audit.record(user, {
      action: 'attendance.punch_void',
      entityType: 'RawPunchEvent',
      entityId: id,
      storeId: row.storeId,
      summary: `Voided a ${row.kind} punch of ${formatHHMMInTz(row.eventAt, store.tz)} on ${dateOnly(date)}`,
      metadata: { before: { voidedAt: null }, after: { voidedAt: voided.voidedAt }, reason: reason ?? null },
    });
    return { id, voidedAt: voided.voidedAt!.toISOString() };
  }

  // -------------------------------------------------------------------------
  // Processing runs
  // -------------------------------------------------------------------------

  /**
   * POST /hrms/processing-runs — rebuild the register from the ledger for a
   * range. Reproducible: the same punches give the same register. Locked
   * months are skipped (counted), punches are never mutated, and only the
   * requested stores' rows are touched.
   */
  async startProcessingRun(user: AuthUser, dto: StartProcessingRunDto) {
    const from = parseYmd(dto.from);
    const to = parseYmd(dto.to);
    if (to < from) throw new BadRequestException('`to` must be on or after `from`');
    if ((to.getTime() - from.getTime()) / DAY_MS > 92) throw new BadRequestException('Date range too large (max 93 days)');
    const storeIds = dto.storeId ? [dto.storeId] : user.storeIds;
    if (dto.storeId) this.scope.assertStoreAllowed(user, dto.storeId);

    const run = await this.prisma.attendanceProcessingRun.create({
      data: {
        organisationId: user.organisationId,
        storeId: dto.storeId ?? null,
        fromDate: from,
        toDate: to,
        startedById: user.id,
      },
    });

    let processed = 0;
    let succeeded = 0;
    let changed = 0;
    let skippedLocked = 0;
    const errors: { storeId: string; userId?: string; date: string; message: string }[] = [];
    try {
      const locks = await this.prisma.payrollPeriodLock.findMany({
        where: { organisationId: user.organisationId, reopenedAt: null },
        select: { month: true },
      });
      const locked = new Set(locks.map((l) => l.month));

      for (const store of await this.stores(user.organisationId, storeIds)) {
        const today = businessDate(new Date(), store.tz);
        const last = to < today ? to : today;
        const [records, punches] = await Promise.all([
          this.prisma.attendanceRecord.findMany({ where: { storeId: store.id, date: { gte: from, lte: last } } }),
          this.prisma.rawPunchEvent.findMany({
            where: {
              storeId: store.id,
              eventAt: {
                gte: instantFromLocalTime(addDays(from, -1), 0, store.tz),
                lt: instantFromLocalTime(addDays(last, 2), 0, store.tz),
              },
            },
            select: { id: true, userId: true, kind: true, eventAt: true, source: true, voidedAt: true },
          }),
        ]);
        const recordAt = new Map(records.map((r) => [`${r.staffId}|${dateOnly(r.date)}`, r]));
        const punchesOf = new Map<string, PunchLite[]>();
        for (const p of punches) punchesOf.set(p.userId, [...(punchesOf.get(p.userId) ?? []), p]);

        for (let d = from; d <= last; d = addDays(d, 1)) {
          if (locked.has(dateOnly(d).slice(0, 7))) {
            skippedLocked++;
            continue;
          }
          const ruleGaps = await absenceRuleGaps(this.prisma, store.id, d);
          for (const e of await eligibleStaff(this.prisma, user.organisationId, [store.id], d)) {
            processed++;
            try {
              const didChange = await this.reprocessDay({
                orgId: user.organisationId,
                store,
                userId: e.userId,
                staffName: e.name,
                date: d,
                facts: e,
                existing: recordAt.get(`${e.userId}|${dateOnly(d)}`) ?? null,
                punches: (punchesOf.get(e.userId) ?? []).filter(
                  (p) => Math.abs(p.eventAt.getTime() - d.getTime()) < 3 * DAY_MS,
                ),
                today,
                ruleGaps,
              });
              if (didChange) changed++;
              succeeded++;
            } catch (err) {
              errors.push({ storeId: store.id, userId: e.userId, date: dateOnly(d), message: (err as Error).message });
            }
          }
        }
      }
    } catch (err) {
      errors.push({ storeId: dto.storeId ?? '*', date: dto.from, message: (err as Error).message });
    }

    const done = await this.prisma.attendanceProcessingRun.update({
      where: { id: run.id },
      data: {
        status: errors.length ? (succeeded === 0 ? 'failed' : 'partially_failed') : 'done',
        processed,
        changed,
        skippedLocked,
        errors: errors.length ? errors.slice(0, 100) : undefined,
        finishedAt: new Date(),
      },
    });
    await this.audit.record(user, {
      action: 'attendance.processing_run',
      entityType: 'AttendanceProcessingRun',
      entityId: run.id,
      storeId: dto.storeId ?? null,
      summary: `Processed attendance ${dto.from} → ${dto.to}: ${changed} of ${processed} employee-days changed, ${skippedLocked} locked days skipped`,
      metadata: { from: dto.from, to: dto.to, storeId: dto.storeId ?? null, processed, changed, skippedLocked, errors: errors.length },
    });
    return this.toRunView(done);
  }

  private toRunView(r: AttendanceProcessingRun) {
    return {
      id: r.id,
      storeId: r.storeId,
      fromDate: dateOnly(r.fromDate),
      toDate: dateOnly(r.toDate),
      status: r.status,
      processed: r.processed,
      changed: r.changed,
      skippedLocked: r.skippedLocked,
      errors: r.errors ?? null,
      startedById: r.startedById,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    };
  }

  /** GET /hrms/processing-runs — the last 20. */
  async processingRuns(user: AuthUser) {
    const rows = await this.prisma.attendanceProcessingRun.findMany({
      where: { organisationId: user.organisationId },
      orderBy: { startedAt: 'desc' },
      take: 20,
    });
    const stores = new Map(
      (await this.stores(user.organisationId, [...new Set(rows.map((r) => r.storeId).filter(Boolean))] as string[])).map(
        (s) => [s.id, s.name],
      ),
    );
    return rows.map((r) => ({ ...this.toRunView(r), storeName: r.storeId ? (stores.get(r.storeId) ?? null) : null }));
  }

  // -------------------------------------------------------------------------
  // Payroll locks
  // -------------------------------------------------------------------------

  async payrollLocks(user: AuthUser) {
    const rows = await this.prisma.payrollPeriodLock.findMany({
      where: { organisationId: user.organisationId },
      orderBy: { month: 'desc' },
    });
    const ids = [...new Set(rows.flatMap((r) => [r.lockedById, r.reopenedById]).filter(Boolean))] as string[];
    const names = new Map(
      (await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u]),
    );
    return rows.map((r) => this.toLockView(r, names));
  }

  private toLockView(r: PayrollPeriodLock, names: Map<string, { id: string; name: string }>) {
    return {
      id: r.id,
      month: r.month,
      locked: r.reopenedAt == null,
      lockedAt: r.lockedAt.toISOString(),
      lockedBy: r.lockedById ? (names.get(r.lockedById) ?? null) : null,
      reopenedAt: r.reopenedAt ? r.reopenedAt.toISOString() : null,
      reopenedBy: r.reopenedById ? (names.get(r.reopenedById) ?? null) : null,
      reopenReason: r.reopenReason ?? null,
    };
  }

  /** POST /hrms/payroll-locks — lock (or re-lock) a month. */
  async lockMonth(user: AuthUser, month: string) {
    const existing = await this.prisma.payrollPeriodLock.findUnique({
      where: { organisationId_month: { organisationId: user.organisationId, month } },
    });
    if (existing && !existing.reopenedAt) throw new ConflictException(`Payroll for ${month} is already locked`);
    const row = existing
      ? await this.prisma.payrollPeriodLock.update({
          where: { id: existing.id },
          data: { lockedAt: new Date(), lockedById: user.id, reopenedAt: null, reopenedById: null, reopenReason: null },
        })
      : await this.prisma.payrollPeriodLock.create({
          data: { organisationId: user.organisationId, month, lockedById: user.id },
        });
    await this.audit.record(user, {
      action: 'payroll.lock',
      entityType: 'PayrollPeriodLock',
      entityId: row.id,
      summary: `Locked payroll for ${month}`,
      metadata: { before: existing ? { reopenedAt: existing.reopenedAt } : null, after: { month, locked: true } },
    });
    return this.toLockView(row, new Map([[user.id, { id: user.id, name: user.name }]]));
  }

  /** POST /hrms/payroll-locks/:month/reopen — with a reason, audited. */
  async reopenMonth(user: AuthUser, month: string, reason: string) {
    const existing = await this.prisma.payrollPeriodLock.findUnique({
      where: { organisationId_month: { organisationId: user.organisationId, month } },
    });
    if (!existing || existing.reopenedAt) throw new NotFoundException(`Payroll for ${month} is not locked`);
    const row = await this.prisma.payrollPeriodLock.update({
      where: { id: existing.id },
      data: { reopenedAt: new Date(), reopenedById: user.id, reopenReason: reason.trim() },
    });
    await this.audit.record(user, {
      action: 'payroll.reopen',
      entityType: 'PayrollPeriodLock',
      entityId: row.id,
      summary: `Reopened payroll for ${month}: ${reason.trim()}`,
      metadata: { before: { locked: true }, after: { locked: false }, reason },
    });
    const names = new Map(
      (
        await this.prisma.user.findMany({
          where: { id: { in: [existing.lockedById, user.id].filter(Boolean) as string[] } },
          select: { id: true, name: true },
        })
      ).map((u) => [u.id, u]),
    );
    return this.toLockView(row, names);
  }

  // -------------------------------------------------------------------------
  // Approvals inbox
  // -------------------------------------------------------------------------

  /** GET /hrms/approvals — leave + regularization in one list, oldest first. */
  async approvals(user: AuthUser, status?: string, headerStore?: string) {
    const where = {
      ...this.scope.storeFilter(user, headerStore),
      ...(status ? { status: status as never } : {}),
    };
    const [leaves, regs] = await Promise.all([
      this.prisma.leaveRequest.findMany({ where, orderBy: { createdAt: 'asc' }, take: 500 }),
      this.prisma.attendanceRegularization.findMany({ where, orderBy: { createdAt: 'asc' }, take: 500 }),
    ]);
    const storeNames = new Map(
      (
        await this.prisma.store.findMany({
          where: { id: { in: [...new Set([...leaves, ...regs].map((x) => x.storeId))] } },
          select: { id: true, name: true, timezone: true },
        })
      ).map((s) => [s.id, s]),
    );
    const now = Date.now();
    const age = (d: Date) => Math.round(((now - d.getTime()) / 3_600_000) * 10) / 10;
    const items = [
      ...leaves.map((l) => ({
        kind: 'leave' as const,
        id: l.id,
        staffId: l.staffId,
        staffName: l.staffName ?? l.staffId,
        storeId: l.storeId,
        storeName: storeNames.get(l.storeId)?.name ?? null,
        submittedAt: l.createdAt.toISOString(),
        summary: `${l.type.replace(/_/g, ' ')} leave · ${Number(l.days ?? 0)} day(s)${l.halfDay ? ' (half day)' : ''}`,
        from: dateOnly(l.fromDate),
        to: dateOnly(l.toDate),
        days: l.days != null ? Number(l.days) : undefined,
        reason: l.reason ?? null,
        status: l.status,
        ageHours: age(l.createdAt),
        leaveType: l.type,
        halfDay: l.halfDay,
      })),
      ...regs.map((r) => {
        const tz = resolveTz(storeNames.get(r.storeId)?.timezone);
        const parts = [
          r.requestedCheckIn ? `in ${formatHHMMInTz(r.requestedCheckIn, tz)}` : null,
          r.requestedCheckOut ? `out ${formatHHMMInTz(r.requestedCheckOut, tz)}` : null,
        ].filter(Boolean);
        return {
          kind: 'regularization' as const,
          id: r.id,
          staffId: r.staffId,
          staffName: r.staffName ?? r.staffId,
          storeId: r.storeId,
          storeName: storeNames.get(r.storeId)?.name ?? null,
          submittedAt: r.createdAt.toISOString(),
          summary: `Attendance fix · ${parts.join(', ')}`,
          from: dateOnly(r.date),
          to: dateOnly(r.date),
          reason: r.reason ?? null,
          status: r.status,
          ageHours: age(r.createdAt),
        };
      }),
    ];
    return items.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  }

  // -------------------------------------------------------------------------
  // Shifts, holidays, shift assignments
  // -------------------------------------------------------------------------

  private async shiftInScope(user: AuthUser, id: string) {
    const shift = await this.prisma.shift.findFirst({
      where: {
        id,
        organisationId: user.organisationId,
        storeId: { in: user.storeIds },
        store: { isHolding: false },
      },
    });
    if (!shift) throw new NotFoundException('Shift not found');
    return shift;
  }

  /** A shift definition is not versioned, so changing it would rewrite any locked month that used it. */
  private async assertShiftDefinitionOpen(orgId: string, shiftId: string): Promise<void> {
    const locks = await this.prisma.payrollPeriodLock.findMany({
      where: { organisationId: orgId, reopenedAt: null },
      select: { month: true },
    });
    for (const { month } of locks) {
      const [year, oneBasedMonth] = month.split('-').map(Number);
      const start = new Date(Date.UTC(year, oneBasedMonth - 1, 1));
      const end = new Date(Date.UTC(year, oneBasedMonth, 0));
      const [assignment, attendance] = await Promise.all([
        this.prisma.shiftAssignment.findFirst({
          where: {
            shiftId,
            effectiveFrom: { lte: end },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }],
          },
          select: { id: true },
        }),
        this.prisma.attendanceRecord.findFirst({
          where: { organisationId: orgId, shiftId, date: { gte: start, lte: end } },
          select: { id: true },
        }),
      ]);
      if (assignment || attendance) {
        throw new ConflictException(
          `This shift affected locked payroll for ${month}. Reopen the period before changing it.`,
        );
      }
    }
  }

  private async assertNoAssignmentOverlap(
    prisma: Db,
    input: {
      organisationId: string;
      userId: string;
      storeId: string;
      from: Date;
      to: Date | null;
      excludeId?: string;
    },
  ): Promise<void> {
    const shiftIds = (
      await prisma.shift.findMany({
        where: { organisationId: input.organisationId, storeId: input.storeId },
        select: { id: true },
      })
    ).map((shift) => shift.id);
    const clash = await prisma.shiftAssignment.findFirst({
      where: {
        organisationId: input.organisationId,
        userId: input.userId,
        shiftId: { in: shiftIds },
        ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
        ...(input.to ? { effectiveFrom: { lte: input.to } } : {}),
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: input.from } }],
      },
      select: { effectiveFrom: true, effectiveTo: true },
    });
    if (clash) {
      throw new ConflictException(
        `This assignment overlaps the existing ${dateOnly(clash.effectiveFrom)} to ${
          clash.effectiveTo ? dateOnly(clash.effectiveTo) : 'ongoing'
        } assignment.`,
      );
    }
  }

  /** PATCH /hrms/shifts/:id */
  async updateShift(user: AuthUser, id: string, dto: UpdateShiftDto) {
    const before = await this.shiftInScope(user, id);
    await this.assertShiftDefinitionOpen(user.organisationId, id);
    const next = { ...before, ...Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)) } as Shift;
    const scheduled = shiftDurationMins(next.startTime, next.endTime);
    if (next.fullDayMins != null && next.fullDayMins > scheduled) {
      throw new BadRequestException(
        `A full day (${next.fullDayMins} min) cannot exceed the shift's own length (${scheduled} min)`,
      );
    }
    if (next.halfDayMins != null && next.halfDayMins > (next.fullDayMins ?? scheduled)) {
      throw new BadRequestException('Half-day threshold cannot exceed the full-day threshold');
    }
    const row = await this.prisma.shift.update({
      where: { id },
      data: {
        name: dto.name,
        code: dto.code === undefined ? undefined : dto.code?.trim() || null,
        startTime: dto.startTime,
        endTime: dto.endTime,
        bufferMins: dto.bufferMins,
        isNightBatch: dto.isNightBatch,
        isFlexible: dto.isFlexible,
        fullDayMins: dto.fullDayMins,
        halfDayMins: dto.halfDayMins,
      },
    });
    await this.audit.record(user, {
      action: 'shift.update',
      entityType: 'Shift',
      entityId: id,
      storeId: row.storeId,
      summary: `Updated shift ${row.name}`,
      metadata: { before: toShiftView(before), after: toShiftView(row) },
    });
    return toShiftView(row);
  }

  /**
   * DELETE /hrms/shifts/:id — refused (409) while any assignment references it
   * or it is on today's register, unless `force`, which deletes its
   * assignments with it (none may dangle). Past register rows keep their
   * shift id as history; the assignment deletions are in the audit metadata.
   */
  async deleteShift(user: AuthUser, id: string, force: boolean) {
    const shift = await this.shiftInScope(user, id);
    await this.assertShiftDefinitionOpen(user.organisationId, id);
    const store = await this.prisma.store.findUnique({ where: { id: shift.storeId }, select: { timezone: true } });
    const today = businessDate(new Date(), resolveTz(store?.timezone));
    // Every assignment counts, past ones too: they would dangle once the shift is gone.
    const [assigned, usedToday] = await Promise.all([
      this.prisma.shiftAssignment.count({ where: { shiftId: id } }),
      this.prisma.attendanceRecord.count({ where: { shiftId: id, date: today } }),
    ]);
    if ((assigned || usedToday) && !force) {
      throw new ConflictException(
        `This shift is ${assigned ? `assigned to ${assigned} employee(s)` : ''}${assigned && usedToday ? ' and ' : ''}${
          usedToday ? `on ${usedToday} of today's register rows` : ''
        }. Delete with force to unassign them.`,
      );
    }
    await this.prisma.$transaction([
      this.prisma.shiftAssignment.deleteMany({ where: { shiftId: id } }),
      this.prisma.shift.delete({ where: { id } }),
    ]);
    await this.audit.record(user, {
      action: 'shift.delete',
      entityType: 'Shift',
      entityId: id,
      storeId: shift.storeId,
      summary: `Deleted shift ${shift.name}${assigned ? ` (unassigned ${assigned})` : ''}`,
      metadata: { before: toShiftView(shift), after: null, force, unassigned: assigned },
    });
    return { id, deleted: true, unassigned: assigned };
  }

  private async holidayInScope(user: AuthUser, id: string) {
    const h = await this.prisma.storeHoliday.findFirst({
      where: {
        id,
        organisationId: user.organisationId,
        storeId: { in: user.storeIds },
        store: { isHolding: false },
      },
    });
    if (!h) throw new NotFoundException('Holiday not found');
    return h;
  }

  /** PATCH /hrms/holidays/:id */
  async updateHoliday(user: AuthUser, id: string, dto: UpdateHolidayDto) {
    const before = await this.holidayInScope(user, id);
    const date = dto.date ? parseYmd(dto.date) : before.date;
    await assertMonthOpen(this.prisma, user.organisationId, before.date);
    await assertMonthOpen(this.prisma, user.organisationId, date);
    const clash = await this.prisma.storeHoliday.findFirst({
      where: { storeId: before.storeId, date, id: { not: id } },
    });
    if (clash) throw new ConflictException(`${dateOnly(date)} is already a holiday at this store`);
    const row = await this.prisma.storeHoliday.update({
      where: { id },
      data: { date, label: dto.label === undefined ? undefined : dto.label?.trim() || null },
    });
    await this.audit.record(user, {
      action: 'holiday.update',
      entityType: 'StoreHoliday',
      entityId: id,
      storeId: row.storeId,
      summary: `Updated holiday ${dateOnly(row.date)}${row.label ? ` (${row.label})` : ''}`,
      metadata: { before: toHolidayView(before), after: toHolidayView(row) },
    });
    return toHolidayView(row);
  }

  /** DELETE /hrms/holidays/:id */
  async deleteHoliday(user: AuthUser, id: string) {
    const before = await this.holidayInScope(user, id);
    await assertMonthOpen(this.prisma, user.organisationId, before.date);
    await this.prisma.storeHoliday.delete({ where: { id } });
    await this.audit.record(user, {
      action: 'holiday.delete',
      entityType: 'StoreHoliday',
      entityId: id,
      storeId: before.storeId,
      summary: `Deleted holiday ${dateOnly(before.date)}`,
      metadata: { before: toHolidayView(before), after: null },
    });
    return { id, deleted: true };
  }

  /** GET /hrms/shift-assignments?userId&storeId */
  async shiftAssignments(user: AuthUser, q: { userId?: string; storeId?: string }) {
    const storeIds = this.scope.effectiveStoreIds(user, q.storeId);
    const shifts = await this.prisma.shift.findMany({ where: { storeId: { in: storeIds } } });
    const shiftById = new Map(shifts.map((s) => [s.id, s]));
    const rows = await this.prisma.shiftAssignment.findMany({
      where: {
        organisationId: user.organisationId,
        shiftId: { in: shifts.map((s) => s.id) },
        ...(q.userId ? { userId: q.userId } : {}),
      },
      include: { user: { select: { name: true } } },
      orderBy: [{ userId: 'asc' }, { effectiveFrom: 'desc' }],
    });
    return rows.map((r) => this.toAssignmentView(r, shiftById.get(r.shiftId) ?? null));
  }

  private toAssignmentView(
    r: { id: string; userId: string; shiftId: string; effectiveFrom: Date; effectiveTo: Date | null; user?: { name: string } },
    shift: Shift | null,
  ) {
    return {
      id: r.id,
      userId: r.userId,
      userName: r.user?.name ?? null,
      shiftId: r.shiftId,
      shiftName: shift?.name ?? null,
      storeId: shift?.storeId ?? null,
      shift: shift ? { id: shift.id, name: shift.name, startTime: shift.startTime, endTime: shift.endTime } : null,
      effectiveFrom: dateOnly(r.effectiveFrom),
      effectiveTo: r.effectiveTo ? dateOnly(r.effectiveTo) : null,
    };
  }

  /**
   * POST /hrms/shift-assignments — from `effectiveFrom`, closing the open
   * assignment at the same store the day before. History is never rewritten:
   * an assignment starting on/after the new date must be edited instead.
   */
  async createShiftAssignment(user: AuthUser, dto: CreateShiftAssignmentDto) {
    const shift = await this.shiftInScope(user, dto.shiftId);
    const member = await this.prisma.userStore.findFirst({
      where: { userId: dto.userId, storeId: shift.storeId },
      include: { user: { select: { name: true } } },
    });
    if (!member) throw new BadRequestException('Staff is not assigned to this shift’s store');
    await assertCanCorrectUser(this.prisma, user, dto.userId);
    const from = parseYmd(dto.effectiveFrom);
    await assertEffectiveRangeOpen(this.prisma, user.organisationId, from, null);
    const storeShiftIds = (
      await this.prisma.shift.findMany({ where: { storeId: shift.storeId }, select: { id: true } })
    ).map((s) => s.id);
    const later = await this.prisma.shiftAssignment.findFirst({
      where: { userId: dto.userId, shiftId: { in: storeShiftIds }, effectiveFrom: { gte: from } },
    });
    if (later) {
      throw new ConflictException(
        `An assignment already starts on ${dateOnly(later.effectiveFrom)}; edit or delete it instead`,
      );
    }
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.shiftAssignment.updateMany({
        where: {
          userId: dto.userId,
          shiftId: { in: storeShiftIds },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
        },
        data: { effectiveTo: addDays(from, -1) },
      });
      await this.assertNoAssignmentOverlap(tx, {
        organisationId: user.organisationId,
        userId: dto.userId,
        storeId: shift.storeId,
        from,
        to: null,
      });
      return tx.shiftAssignment.create({
        data: {
          organisationId: user.organisationId,
          userId: dto.userId,
          shiftId: shift.id,
          effectiveFrom: from,
          createdById: user.id,
        },
      });
    });
    await this.audit.record(user, {
      action: 'shift_assignment.create',
      entityType: 'ShiftAssignment',
      entityId: row.id,
      storeId: shift.storeId,
      summary: `Assigned ${member.user.name} to ${shift.name} from ${dto.effectiveFrom}`,
      metadata: { before: null, after: { userId: dto.userId, shiftId: shift.id, effectiveFrom: dto.effectiveFrom } },
    });
    return this.toAssignmentView({ ...row, user: member.user }, shift);
  }

  private async assignmentInScope(user: AuthUser, id: string) {
    const row = await this.prisma.shiftAssignment.findFirst({
      where: { id, organisationId: user.organisationId },
      include: { user: { select: { name: true } } },
    });
    if (!row) throw new NotFoundException('Shift assignment not found');
    const shift = await this.prisma.shift.findUnique({ where: { id: row.shiftId } });
    if (!shift || !user.storeIds.includes(shift.storeId)) throw new NotFoundException('Shift assignment not found');
    await assertCanCorrectUser(this.prisma, user, row.userId);
    return { row, shift };
  }

  /** PATCH /hrms/shift-assignments/:id */
  async updateShiftAssignment(user: AuthUser, id: string, dto: UpdateShiftAssignmentDto) {
    const { row: before, shift: beforeShift } = await this.assignmentInScope(user, id);
    const shift = dto.shiftId ? await this.shiftInScope(user, dto.shiftId) : beforeShift;
    if (dto.shiftId && beforeShift && shift && shift.storeId !== beforeShift.storeId) {
      throw new BadRequestException('Move to a shift at the same store, or create a new assignment');
    }
    const from = dto.effectiveFrom ? parseYmd(dto.effectiveFrom) : before.effectiveFrom;
    const to =
      dto.effectiveTo === undefined ? before.effectiveTo : dto.effectiveTo === null ? null : parseYmd(dto.effectiveTo);
    if (to && to < from) throw new BadRequestException('effectiveTo must be on or after effectiveFrom');
    await assertEffectiveRangeOpen(
      this.prisma,
      user.organisationId,
      before.effectiveFrom,
      before.effectiveTo,
    );
    await assertEffectiveRangeOpen(this.prisma, user.organisationId, from, to);
    await this.assertNoAssignmentOverlap(this.prisma, {
      organisationId: user.organisationId,
      userId: before.userId,
      storeId: shift.storeId,
      from,
      to,
      excludeId: id,
    });
    const row = await this.prisma.shiftAssignment.update({
      where: { id },
      data: { shiftId: shift?.id ?? before.shiftId, effectiveFrom: from, effectiveTo: to },
      include: { user: { select: { name: true } } },
    });
    await this.audit.record(user, {
      action: 'shift_assignment.update',
      entityType: 'ShiftAssignment',
      entityId: id,
      storeId: shift?.storeId ?? null,
      summary: `Updated ${before.user.name}'s shift assignment`,
      metadata: {
        before: this.toAssignmentView(before, beforeShift),
        after: this.toAssignmentView(row, shift),
      },
    });
    return this.toAssignmentView(row, shift);
  }

  /** DELETE /hrms/shift-assignments/:id */
  async deleteShiftAssignment(user: AuthUser, id: string) {
    const { row, shift } = await this.assignmentInScope(user, id);
    await assertEffectiveRangeOpen(
      this.prisma,
      user.organisationId,
      row.effectiveFrom,
      row.effectiveTo,
    );
    await this.prisma.shiftAssignment.delete({ where: { id } });
    await this.audit.record(user, {
      action: 'shift_assignment.delete',
      entityType: 'ShiftAssignment',
      entityId: id,
      storeId: shift?.storeId ?? null,
      summary: `Removed ${row.user.name}'s shift assignment`,
      metadata: { before: this.toAssignmentView(row, shift), after: null },
    });
    return { id, deleted: true };
  }
}
