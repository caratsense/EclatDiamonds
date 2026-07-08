import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AttendanceStatus, LeaveStatus, LeaveType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { ROLE_RANK } from '../common/role.util';
import {
  ApplyLeaveDto,
  CheckInDto,
  CheckOutDto,
  CreateHolidayDto,
  CreateRegularizationDto,
  CreateShiftDto,
  MarkAttendanceDto,
  SetWeekOffDto,
} from './dto/hrms.dto';

/**
 * Default annual leave allocations by type (Module 6, Zoho-informed). The enum has
 * no dedicated "unpaid" type; `festival` carries a 0 allocation and is treated as
 * unpaid (never balance-validated, never decrements a balance).
 */
const LEAVE_ALLOCATIONS: Record<LeaveType, number> = {
  casual: 12,
  sick: 6,
  earned: 15,
  festival: 0,
};

/** Balance-tracked (paid) leave types: applied against a per-year LeaveBalance. */
const PAID_LEAVE_TYPES: LeaveType[] = ['casual', 'sick', 'earned'];

function num(v: Prisma.Decimal | number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

function initialsOf(name?: string | null): string {
  if (!name) return '—';
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

const LEAVE_TYPE_LABEL: Record<string, string> = {
  casual: 'Casual',
  sick: 'Sick',
  earned: 'Earned',
  festival: 'Festival',
};

function hhmm(d?: Date | null): string | null {
  if (!d) return null;
  return d.toISOString().slice(11, 16);
}

/** Minutes-since-midnight for a Date, using UTC to match hhmm()'s display convention. */
function minutesOfDay(d: Date): number {
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Parse a "HH:MM" shift time into minutes-since-midnight. */
function parseHHMM(s: string): number {
  const [h, m] = s.split(':');
  return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0);
}

/**
 * Lateness vs a shift: late only if check-in is after (start + buffer). Because it is
 * measured against the ASSIGNED shift, a night/second-batch check-in in the afternoon
 * is naturally on time (its own start is in the afternoon).
 */
function computeLateness(
  checkInAt: Date,
  startTime: string,
  bufferMins: number,
): { isLate: boolean; lateMinutes: number } {
  const threshold = parseHHMM(startTime) + bufferMins;
  const lateMinutes = Math.max(0, minutesOfDay(checkInAt) - threshold);
  return { isLate: lateMinutes > 0, lateMinutes };
}

/** Resolve a "YYYY-MM" (or current month) to a UTC [start, end) range + normalized label. */
function monthRange(month?: string): { start: Date; end: Date; label: string } {
  const now = new Date();
  let year = now.getUTCFullYear();
  let mon = now.getUTCMonth(); // 0-based
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map((x) => parseInt(x, 10));
    year = y;
    mon = m - 1;
  }
  const start = new Date(Date.UTC(year, mon, 1));
  const end = new Date(Date.UTC(year, mon + 1, 1));
  const label = `${year}-${String(mon + 1).padStart(2, '0')}`;
  return { start, end, label };
}

function toShiftView(s: any) {
  return {
    id: s.id,
    storeId: s.storeId,
    name: s.name,
    startTime: s.startTime,
    endTime: s.endTime,
    bufferMins: s.bufferMins,
    isNightBatch: s.isNightBatch,
    label: `${s.name} · ${s.startTime}–${s.endTime}`,
  };
}

function toHolidayView(h: any) {
  return {
    id: h.id,
    storeId: h.storeId,
    date: h.date.toISOString().slice(0, 10),
    label: h.label ?? null,
  };
}

/** Haversine distance (metres) between two lat/lng points. */
function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  if (!lat1 || !lng1 || !lat2 || !lng2) return 0;
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/**
 * Raw haversine distance (metres, unrounded) with R = 6371000. Unlike distanceM()
 * this does not treat a 0 coordinate as "missing", so it is safe for real punches
 * near the equator/prime meridian. Callers guard on store coords being present.
 */
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** UTC-midnight of the current calendar date, matching the @db.Date columns. */
function todayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Parse a YYYY-MM-DD (or ISO) date string to its UTC-midnight Date (@db.Date). */
function parseDateOnly(s: string): Date {
  const d = new Date(s);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

@Injectable()
export class HrmsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
  ) {}

  /** GET /hrms/attendance — today's attendance with geo-verification, store-scoped. */
  async attendance(user: AuthUser, headerStore?: string) {
    const where = this.scope.storeFilter(user, headerStore);
    const rows = await this.prisma.attendanceRecord.findMany({
      where,
      include: { store: true },
      orderBy: [{ date: 'desc' }, { staffName: 'asc' }],
      take: 200,
    });
    return rows.map((r) => this.toAttendanceView(r));
  }

  /** Shape an AttendanceRecord (with its `store`) into the frontend attendance row. */
  private toAttendanceView(r: any) {
    const centreLat = num(r.store.latitude);
    const centreLng = num(r.store.longitude);
    const pingLat = num(r.checkInLat);
    const pingLng = num(r.checkInLng);
    const dist = distanceM(centreLat, centreLng, pingLat, pingLng);
    return {
      id: r.id,
      storeId: r.storeId,
      staffId: r.staffId,
      name: r.staffName ?? r.staffId,
      initials: initialsOf(r.staffName),
      role: 'Sales Executive',
      shift: r.status === 'on_leave' || r.status === 'absent' ? '—' : 'Morning · 10:00–19:00',
      checkIn: hhmm(r.checkInAt),
      checkOut: hhmm(r.checkOutAt),
      status: r.status,
      ping: { lat: pingLat, lng: pingLng },
      distanceM: dist,
      withinFence: r.geoVerified,
      shiftId: r.shiftId ?? null,
      isLate: r.isLate ?? false,
      lateMinutes: r.lateMinutes ?? null,
    };
  }

  /**
   * POST /hrms/attendance — record a manual/tablet attendance ping, store-scoped.
   *
   * If a `shiftId` is supplied, lateness is computed against THAT shift's start +
   * buffer and `status` is set to `late`/`present` accordingly. A night/second-batch
   * check-in in the afternoon is on time because it's measured vs its own shift.
   * With no shift the behaviour is unchanged (client-supplied status is kept).
   */
  async markAttendance(user: AuthUser, dto: MarkAttendanceDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);

    const date = new Date();
    date.setHours(0, 0, 0, 0);
    const checkInAt = dto.checkInAt ? new Date(dto.checkInAt) : new Date();

    let status: AttendanceStatus = dto.status;
    let shiftId: string | null = null;
    let isLate = false;
    let lateMinutes: number | null = null;

    if (dto.shiftId) {
      const shift = await this.prisma.shift.findFirst({
        where: { id: dto.shiftId, storeId: dto.storeId },
      });
      if (!shift) throw new NotFoundException('Shift not found for this store');
      const late = computeLateness(checkInAt, shift.startTime, shift.bufferMins);
      isLate = late.isLate;
      lateMinutes = late.lateMinutes;
      status = isLate ? 'late' : 'present';
      shiftId = shift.id;
    }

    const row = await this.prisma.attendanceRecord.create({
      data: {
        storeId: dto.storeId,
        staffId: dto.staffId ?? `att-${Date.now()}`,
        staffName: dto.staffName,
        date,
        status,
        checkInAt,
        shiftId,
        isLate,
        lateMinutes,
      },
      include: { store: true },
    });
    return this.toAttendanceView(row);
  }

  /** GET /hrms/shifts — store shifts/batches, store-scoped. */
  async shifts(user: AuthUser, headerStore?: string) {
    const where = this.scope.storeFilter(user, headerStore);
    const rows = await this.prisma.shift.findMany({
      where,
      orderBy: [{ storeId: 'asc' }, { startTime: 'asc' }],
    });
    return rows.map(toShiftView);
  }

  /** POST /hrms/shifts — create a store shift/batch (manager+). */
  async createShift(user: AuthUser, dto: CreateShiftDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);
    const row = await this.prisma.shift.create({
      data: {
        storeId: dto.storeId,
        name: dto.name,
        startTime: dto.startTime,
        endTime: dto.endTime,
        bufferMins: dto.bufferMins ?? 15,
        isNightBatch: dto.isNightBatch ?? false,
      },
    });
    return toShiftView(row);
  }

  /** GET /hrms/holidays — per-store holidays, store-scoped. */
  async holidays(user: AuthUser, headerStore?: string) {
    const where = this.scope.storeFilter(user, headerStore);
    const rows = await this.prisma.storeHoliday.findMany({
      where,
      orderBy: { date: 'asc' },
    });
    return rows.map(toHolidayView);
  }

  /** POST /hrms/holidays — configure a per-store holiday (manager+). */
  async createHoliday(user: AuthUser, dto: CreateHolidayDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);
    const date = new Date(dto.date);
    date.setUTCHours(0, 0, 0, 0);
    const row = await this.prisma.storeHoliday.upsert({
      where: { storeId_date: { storeId: dto.storeId, date } },
      update: { label: dto.label ?? null },
      create: { storeId: dto.storeId, date, label: dto.label ?? null },
    });
    return toHolidayView(row);
  }

  /** PATCH /hrms/week-off — set a store's weekly off day (HO/area only). */
  async setWeekOff(user: AuthUser, dto: SetWeekOffDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);
    const existing = await this.prisma.store.findUnique({ where: { id: dto.storeId } });
    if (!existing) throw new NotFoundException('Store not found');
    const store = await this.prisma.store.update({
      where: { id: dto.storeId },
      data: { weekOffDay: dto.weekOffDay },
    });
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return {
      storeId: store.id,
      name: store.name,
      weekOffDay: store.weekOffDay,
      weekOffLabel: store.weekOffDay == null ? null : dayNames[store.weekOffDay],
    };
  }

  /**
   * GET /hrms/late-flags — per-staff late-check-in counts for a month, store-scoped.
   * At 3+ late check-ins the staff is `flagged`. FLAG ONLY: half-day / salary
   * automation is deferred (client call 2026-07) — no salary math is done here.
   */
  async lateFlags(user: AuthUser, month?: string, headerStore?: string) {
    const note =
      'Flag only — half-day/salary automation is deferred (client call 2026-07). ' +
      'A staff is flagged at 3+ late check-ins in the month.';
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    const { start, end, label } = monthRange(month);
    if (storeIds.length === 0) return { month: label, note, staff: [] };

    const grouped = await this.prisma.attendanceRecord.groupBy({
      by: ['staffId', 'staffName', 'storeId'],
      where: {
        storeId: { in: storeIds },
        isLate: true,
        date: { gte: start, lt: end },
      },
      _count: { _all: true },
    });

    const staff = grouped
      .map((g) => ({
        staffId: g.staffId,
        staffName: g.staffName ?? g.staffId,
        storeId: g.storeId,
        lateCount: g._count._all,
        flagged: g._count._all >= 3,
      }))
      .sort((a, b) => b.lateCount - a.lateCount);

    return { month: label, note, staff };
  }

  /** GET /hrms/leave — leave requests, store-scoped. */
  async leave(user: AuthUser, headerStore?: string) {
    const rows = await this.prisma.leaveRequest.findMany({
      where: this.scope.storeFilter(user, headerStore),
      orderBy: { fromDate: 'desc' },
    });
    return rows.map((r) => this.toLeaveView(r));
  }

  /**
   * PATCH /hrms/leave/:id — approve/reject a leave request. Approving a paid-type
   * request increments that year's LeaveBalance.used by the request's days (seeding
   * the balance if missing); moving an approved request off "approved" restores it.
   */
  async decideLeave(user: AuthUser, id: string, status: LeaveStatus) {
    const existing = await this.prisma.leaveRequest.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
    });
    if (!existing) throw new NotFoundException('Leave request not found');

    const prevStatus = existing.status;
    const days = num(existing.days);
    if (PAID_LEAVE_TYPES.includes(existing.type) && days > 0 && status !== prevStatus) {
      const year = existing.fromDate.getUTCFullYear();
      if (status === 'approved') {
        // Newly approved: consume balance.
        await this.ensureLeaveBalances(existing.staffId, year, existing.storeId);
        await this.prisma.leaveBalance.update({
          where: { userId_type_year: { userId: existing.staffId, type: existing.type, year } },
          data: { used: { increment: days } },
        });
      } else if (prevStatus === 'approved') {
        // Leaving an approved state (reject/re-open): restore balance, floored at 0.
        await this.ensureLeaveBalances(existing.staffId, year, existing.storeId);
        const bal = await this.prisma.leaveBalance.findUnique({
          where: { userId_type_year: { userId: existing.staffId, type: existing.type, year } },
        });
        await this.prisma.leaveBalance.update({
          where: { userId_type_year: { userId: existing.staffId, type: existing.type, year } },
          data: { used: Math.max(0, num(bal?.used) - days) },
        });
      }
    }

    const row = await this.prisma.leaveRequest.update({ where: { id }, data: { status } });
    return this.toLeaveView(row);
  }

  private toLeaveView(r: any) {
    // Prefer the persisted (working-day/half-day aware) count; fall back to the
    // inclusive calendar span for legacy rows created before `days` existed.
    const days =
      r.days != null
        ? num(r.days)
        : Math.round((r.toDate.getTime() - r.fromDate.getTime()) / 86400000) + 1;
    const fmt = (d: Date) =>
      `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
    return {
      id: r.id,
      storeId: r.storeId,
      staffId: r.staffId,
      name: r.staffName ?? r.staffId,
      initials: initialsOf(r.staffName),
      type: LEAVE_TYPE_LABEL[r.type] ?? r.type,
      from: fmt(r.fromDate),
      to: fmt(r.toDate),
      days,
      halfDay: r.halfDay ?? false,
      reason: r.reason ?? '',
      status: r.status,
    };
  }

  /** GET /hrms/leaderboard — sales-staff leaderboard derived from sales + check-ins. */
  async leaderboard(user: AuthUser, headerStore?: string) {
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    if (storeIds.length === 0) return [];

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [sales, checkIns, users] = await Promise.all([
      this.prisma.sale.groupBy({
        by: ['salesPersonId'],
        where: { storeId: { in: storeIds }, isCancelled: false, docType: 'sale', docDate: { gte: monthStart } },
        _sum: { totalAmount: true },
        _count: { _all: true },
      }),
      this.prisma.checkIn.groupBy({
        by: ['repId'],
        where: { storeId: { in: storeIds }, timeIn: { gte: monthStart } },
        _count: { _all: true },
      }),
      this.prisma.user.findMany({
        where: {
          userStores: { some: { storeId: { in: storeIds } } },
          // OP-5: a salesperson only ever sees their own leaderboard row.
          ...(user.role === 'salesperson' ? { id: user.id } : {}),
        },
        include: { userStores: true },
      }),
    ]);

    const salesByUser = new Map(sales.map((s) => [s.salesPersonId, s]));
    const footfallByRep = new Map(checkIns.map((c) => [c.repId, c._count._all]));

    const rows = users
      .map((u) => {
        const s = salesByUser.get(u.id);
        const storeId = u.userStores[0]?.storeId ?? '';
        const closed = s?._count._all ?? 0;
        const revenue = num(s?._sum.totalAmount);
        return {
          staffId: u.id,
          name: u.name,
          initials: u.initials ?? initialsOf(u.name),
          role: 'Sales Executive',
          storeId,
          footfall: footfallByRep.get(u.id) ?? 0,
          quotes: 0,
          closed,
          revenue,
        };
      })
      .filter((r) => r.revenue > 0 || r.footfall > 0)
      .sort((a, b) => b.revenue - a.revenue);

    // Backfill quote counts.
    const quoteCounts = await this.prisma.quote.groupBy({
      by: ['assignedRepId'],
      where: { storeId: { in: storeIds } },
      _count: { _all: true },
    });
    const qByRep = new Map(quoteCounts.map((q) => [q.assignedRepId, q._count._all]));
    for (const r of rows) r.quotes = qByRep.get(r.staffId) ?? 0;
    return rows;
  }

  /** GET /hrms/commission — incentive rows from Commission table (+ live sales fallback). */
  async commission(user: AuthUser, headerStore?: string) {
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    if (storeIds.length === 0) return [];

    const commissions = await this.prisma.commission.findMany({
      where: {
        storeId: { in: storeIds },
        // OP-5: a salesperson only ever sees their own incentive numbers.
        ...(user.role === 'salesperson' ? { userId: user.id } : {}),
      },
      include: { user: { include: { userStores: true } } },
      orderBy: { amount: 'desc' },
    });

    return commissions.map((c) => this.toCommissionView(c));
  }

  private toCommissionView(c: any) {
    return {
      id: c.id,
      staffId: c.userId,
      name: c.user.name,
      initials: c.user.initials ?? initialsOf(c.user.name),
      role: 'Sales Executive',
      storeId: c.storeId ?? c.user.userStores?.[0]?.storeId ?? '',
      salesValue: num(c.salesValue),
      rate: num(c.rate) / 100,
      incentive: num(c.amount),
      target: Math.round(num(c.salesValue) * 0.85),
    };
  }

  // ==========================================================================
  // A. Self-service geo check-in / check-out (Module 6)
  // ==========================================================================

  /**
   * POST /hrms/attendance/check-in — the current user punches in from their phone.
   * Geo-fencing is LENIENT: the punch is always recorded; geoVerified/checkInDistanceM
   * merely flag whether it landed inside the store's radius. Lateness is measured
   * against the assigned (or store-default) shift's start + buffer.
   */
  async checkIn(user: AuthUser, dto: CheckInDto, headerStore?: string) {
    const storeId = this.resolveStoreId(user, headerStore, user.storeIds);
    this.scope.assertStoreAllowed(user, storeId);
    const store = await this.prisma.store.findUnique({ where: { id: storeId } });
    if (!store) throw new NotFoundException('Store not found');

    const now = new Date();
    const date = todayUtc();

    // Geofence (lenient): record distance + within-fence flag, never block.
    const storeHasCoords = store.latitude != null && store.longitude != null;
    let checkInDistanceM: number | null = null;
    let withinFence = false;
    if (storeHasCoords) {
      const dist = haversineM(num(store.latitude), num(store.longitude), dto.lat, dto.lng);
      checkInDistanceM = Math.round(dist);
      withinFence = dist <= (store.geofenceRadiusM ?? 150);
    }

    // Lateness vs the assigned shift (or the store's first/default shift if none given).
    const shift = await this.resolveShift(storeId, dto.shiftId);
    let shiftId: string | null = null;
    let isLate = false;
    let lateMinutes: number | null = null;
    if (shift) {
      const late = computeLateness(now, shift.startTime, shift.bufferMins);
      isLate = late.isLate;
      lateMinutes = late.lateMinutes;
      shiftId = shift.id;
    }

    const row = await this.prisma.attendanceRecord.upsert({
      where: { storeId_staffId_date: { storeId, staffId: user.id, date } },
      update: {
        checkInAt: now,
        checkInLat: dto.lat,
        checkInLng: dto.lng,
        geoVerified: withinFence,
        checkInDistanceM,
        status: 'present',
        shiftId,
        isLate,
        lateMinutes,
      },
      create: {
        storeId,
        staffId: user.id,
        staffName: user.name,
        date,
        status: 'present',
        checkInAt: now,
        checkInLat: dto.lat,
        checkInLng: dto.lng,
        geoVerified: withinFence,
        checkInDistanceM,
        shiftId,
        isLate,
        lateMinutes,
      },
    });
    return this.toSelfAttendanceView(row);
  }

  /**
   * POST /hrms/attendance/check-out — the current user punches out; sets checkOut geo
   * + worked minutes. Requires an existing check-in for today.
   */
  async checkOut(user: AuthUser, dto: CheckOutDto, headerStore?: string) {
    const date = todayUtc();
    const record = await this.prisma.attendanceRecord.findFirst({
      where: {
        staffId: user.id,
        date,
        ...this.scope.storeFilter(user, headerStore),
      },
      orderBy: { checkInAt: 'desc' },
    });
    if (!record || !record.checkInAt) {
      throw new BadRequestException('No check-in found for today');
    }

    const now = new Date();
    const workedMins = Math.round((now.getTime() - record.checkInAt.getTime()) / 60000);
    const row = await this.prisma.attendanceRecord.update({
      where: { id: record.id },
      data: {
        checkOutAt: now,
        checkOutLat: dto.lat,
        checkOutLng: dto.lng,
        workedMins,
      },
    });
    return this.toSelfAttendanceView(row);
  }

  /** GET /hrms/attendance/me?month=YYYY-MM — the current user's own punches. */
  async myAttendance(user: AuthUser, month?: string, headerStore?: string) {
    const { start, end } = monthRange(month);
    const scopeFilter = this.scope.storeFilter(user, headerStore);
    const date = todayUtc();

    const [records, todayRow] = await Promise.all([
      this.prisma.attendanceRecord.findMany({
        where: { staffId: user.id, date: { gte: start, lt: end }, ...scopeFilter },
        orderBy: { date: 'desc' },
      }),
      this.prisma.attendanceRecord.findFirst({
        where: { staffId: user.id, date, ...scopeFilter },
        orderBy: { checkInAt: 'desc' },
      }),
    ]);

    return {
      today: todayRow ? this.toSelfAttendanceView(todayRow) : null,
      records: records.map((r) => this.toSelfAttendanceView(r)),
    };
  }

  /** The self-service attendance view (my punches). */
  private toSelfAttendanceView(r: any) {
    return {
      id: r.id,
      storeId: r.storeId,
      date: r.date.toISOString().slice(0, 10),
      status: r.status,
      checkInAt: r.checkInAt,
      checkOutAt: r.checkOutAt,
      checkInDistanceM: r.checkInDistanceM ?? null,
      withinFence: r.geoVerified,
      workedMins: r.workedMins ?? null,
      isLate: r.isLate ?? false,
      lateMinutes: r.lateMinutes ?? null,
      shiftId: r.shiftId ?? null,
    };
  }

  /** The assigned shift (by id, scoped to store) or the store's first/default shift. */
  private async resolveShift(storeId: string, shiftId?: string) {
    if (shiftId) {
      const shift = await this.prisma.shift.findFirst({ where: { id: shiftId, storeId } });
      if (!shift) throw new NotFoundException('Shift not found for this store');
      return shift;
    }
    return this.prisma.shift.findFirst({
      where: { storeId },
      orderBy: { startTime: 'asc' },
    });
  }

  // ==========================================================================
  // B. Leave balances + apply/approve (Module 6)
  // ==========================================================================

  /**
   * GET /hrms/leave/balances — self by default; a manager+ may pass a staffId within
   * scope. Auto-seeds the current year's default allocations on first read.
   */
  async leaveBalances(user: AuthUser, staffId?: string, headerStore?: string) {
    const actor = await this.resolveActor(user, headerStore, staffId);
    const year = new Date().getUTCFullYear();
    await this.ensureLeaveBalances(actor.staffId, year, actor.storeId);

    const rows = await this.prisma.leaveBalance.findMany({
      where: { userId: actor.staffId, year },
      orderBy: { type: 'asc' },
    });
    return rows.map((r) => ({
      type: r.type,
      year: r.year,
      allocated: num(r.allocated),
      used: num(r.used),
      balance: num(r.allocated) - num(r.used),
    }));
  }

  /** Upsert the default allocation rows for a user/year if none exist yet. */
  private async ensureLeaveBalances(userId: string, year: number, storeId?: string | null) {
    const existing = await this.prisma.leaveBalance.count({ where: { userId, year } });
    if (existing > 0) return;
    await Promise.all(
      (Object.keys(LEAVE_ALLOCATIONS) as LeaveType[]).map((type) =>
        this.prisma.leaveBalance.upsert({
          where: { userId_type_year: { userId, type, year } },
          update: {},
          create: { userId, storeId: storeId ?? null, type, year, allocated: LEAVE_ALLOCATIONS[type] },
        }),
      ),
    );
  }

  /**
   * POST /hrms/leave — apply for leave (self, or manager+ on behalf of team staff).
   * Days default to inclusive working days (excludes weekly-off + holidays); paid
   * types are validated against the remaining balance.
   */
  async applyLeave(user: AuthUser, dto: ApplyLeaveDto, headerStore?: string) {
    const actor = await this.resolveActor(user, headerStore, dto.staffId);
    const fromDate = parseDateOnly(dto.fromDate);
    const toDate = parseDateOnly(dto.toDate);
    if (toDate < fromDate) throw new BadRequestException('toDate is before fromDate');

    const halfDay = dto.halfDay ?? false;
    const days =
      dto.days != null
        ? dto.days
        : await this.computeWorkingDays(actor.storeId, fromDate, toDate, halfDay);

    const year = fromDate.getUTCFullYear();
    if (PAID_LEAVE_TYPES.includes(dto.type)) {
      await this.ensureLeaveBalances(actor.staffId, year, actor.storeId);
      const bal = await this.prisma.leaveBalance.findUnique({
        where: { userId_type_year: { userId: actor.staffId, type: dto.type, year } },
      });
      const available = num(bal?.allocated) - num(bal?.used);
      if (available < days) {
        throw new BadRequestException(
          `Insufficient ${dto.type} balance: ${available} day(s) available, ${days} requested`,
        );
      }
    }

    const row = await this.prisma.leaveRequest.create({
      data: {
        storeId: actor.storeId,
        staffId: actor.staffId,
        staffName: actor.staffName,
        type: dto.type,
        fromDate,
        toDate,
        reason: dto.reason ?? null,
        days,
        halfDay,
        status: 'pending',
      },
    });
    return this.toLeaveView(row);
  }

  /**
   * Inclusive working days in [from, to], excluding the store's weekly-off day and any
   * configured holidays. A half-day request counts as 0.5.
   */
  private async computeWorkingDays(
    storeId: string,
    from: Date,
    to: Date,
    halfDay: boolean,
  ): Promise<number> {
    if (halfDay) return 0.5;
    const [store, holidays] = await Promise.all([
      this.prisma.store.findUnique({ where: { id: storeId } }),
      this.prisma.storeHoliday.findMany({
        where: { storeId, date: { gte: from, lte: to } },
      }),
    ]);
    const weekOff = store?.weekOffDay ?? null;
    const holidaySet = new Set(holidays.map((h) => h.date.getTime()));

    let count = 0;
    for (const d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      if (weekOff != null && d.getUTCDay() === weekOff) continue;
      if (holidaySet.has(d.getTime())) continue;
      count++;
    }
    return count;
  }

  // ==========================================================================
  // C. Attendance regularization (Module 6)
  // ==========================================================================

  /** POST /hrms/regularize — request a fix for a missed/wrong punch (current user). */
  async createRegularization(user: AuthUser, dto: CreateRegularizationDto, headerStore?: string) {
    const storeId = this.resolveStoreId(user, headerStore, user.storeIds);
    this.scope.assertStoreAllowed(user, storeId);
    const row = await this.prisma.attendanceRegularization.create({
      data: {
        storeId,
        staffId: user.id,
        staffName: user.name,
        date: parseDateOnly(dto.date),
        requestedCheckIn: dto.requestedCheckIn ? new Date(dto.requestedCheckIn) : null,
        requestedCheckOut: dto.requestedCheckOut ? new Date(dto.requestedCheckOut) : null,
        reason: dto.reason ?? null,
        status: 'pending',
      },
    });
    return this.toRegularizationView(row);
  }

  /** GET /hrms/regularize — store-scoped; staff see only their own requests. */
  async listRegularizations(user: AuthUser, headerStore?: string) {
    const where: Prisma.AttendanceRegularizationWhereInput = {
      ...this.scope.storeFilter(user, headerStore),
    };
    if (ROLE_RANK[user.role] < ROLE_RANK.store_manager) where.staffId = user.id;
    const rows = await this.prisma.attendanceRegularization.findMany({
      where,
      orderBy: { date: 'desc' },
    });
    return rows.map((r) => this.toRegularizationView(r));
  }

  /**
   * PATCH /hrms/regularize/:id — approve/reject (manager+). On approval the requested
   * punch(es) are applied to that day's AttendanceRecord (upserted) and worked minutes
   * + lateness are recomputed.
   */
  async decideRegularization(user: AuthUser, id: string, status: LeaveStatus) {
    const existing = await this.prisma.attendanceRegularization.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
    });
    if (!existing) throw new NotFoundException('Regularization not found');

    if (status === 'approved') {
      const { storeId, staffId, staffName, date } = existing;
      const current = await this.prisma.attendanceRecord.findUnique({
        where: { storeId_staffId_date: { storeId, staffId, date } },
      });
      const checkInAt = existing.requestedCheckIn ?? current?.checkInAt ?? null;
      const checkOutAt = existing.requestedCheckOut ?? current?.checkOutAt ?? null;

      const workedMins =
        checkInAt && checkOutAt
          ? Math.round((checkOutAt.getTime() - checkInAt.getTime()) / 60000)
          : (current?.workedMins ?? null);

      let isLate = current?.isLate ?? false;
      let lateMinutes = current?.lateMinutes ?? null;
      let shiftId = current?.shiftId ?? null;
      if (checkInAt) {
        // Respect the record's assigned shift; fall back to the store's default
        // shift. Non-throwing: a deleted shiftId just yields no lateness recompute.
        const shift = shiftId
          ? await this.prisma.shift.findFirst({ where: { id: shiftId, storeId } })
          : await this.prisma.shift.findFirst({ where: { storeId }, orderBy: { startTime: 'asc' } });
        if (shift) {
          const late = computeLateness(checkInAt, shift.startTime, shift.bufferMins);
          isLate = late.isLate;
          lateMinutes = late.lateMinutes;
          shiftId = shift.id;
        }
      }

      await this.prisma.attendanceRecord.upsert({
        where: { storeId_staffId_date: { storeId, staffId, date } },
        update: { checkInAt, checkOutAt, workedMins, isLate, lateMinutes, shiftId, status: 'present' },
        create: {
          storeId,
          staffId,
          staffName,
          date,
          status: 'present',
          checkInAt,
          checkOutAt,
          workedMins,
          isLate,
          lateMinutes,
          shiftId,
        },
      });
    }

    const row = await this.prisma.attendanceRegularization.update({
      where: { id },
      data: { status },
    });
    return this.toRegularizationView(row);
  }

  private toRegularizationView(r: any) {
    return {
      id: r.id,
      storeId: r.storeId,
      staffId: r.staffId,
      name: r.staffName ?? r.staffId,
      initials: initialsOf(r.staffName),
      date: r.date.toISOString().slice(0, 10),
      requestedCheckIn: r.requestedCheckIn,
      requestedCheckOut: r.requestedCheckOut,
      reason: r.reason ?? null,
      status: r.status,
    };
  }

  // ==========================================================================
  // D. Editable commission rate (Module 6)
  // ==========================================================================

  /**
   * PATCH /hrms/commission/:id — set the rate and recompute the incentive amount
   * (amount = salesValue × rate / 100). Scoped via the row's storeId (or its user's
   * store when the row has no store).
   */
  async updateCommissionRate(user: AuthUser, id: string, rate: number) {
    const existing = await this.prisma.commission.findUnique({
      where: { id },
      include: { user: { include: { userStores: true } } },
    });
    if (!existing) throw new NotFoundException('Commission not found');

    if (!user.allStores) {
      const rowStoreId = existing.storeId ?? existing.user.userStores[0]?.storeId;
      if (!rowStoreId || !user.storeIds.includes(rowStoreId)) {
        throw new ForbiddenException('Commission not in your scope');
      }
    }

    const amount = new Prisma.Decimal(existing.salesValue).mul(rate).div(100);
    const row = await this.prisma.commission.update({
      where: { id },
      data: { rate, amount },
      include: { user: { include: { userStores: true } } },
    });
    return this.toCommissionView(row);
  }

  // ==========================================================================
  // Shared resolution helpers
  // ==========================================================================

  /**
   * Resolve the store for a self-service action: the header store if given and in
   * scope, else the first of the supplied fallback stores.
   */
  private resolveStoreId(user: AuthUser, headerStore: string | undefined, fallback: string[]): string {
    if (headerStore && headerStore !== 'all') {
      this.scope.assertStoreAllowed(user, headerStore);
      return headerStore;
    }
    const first = fallback[0];
    if (!first) throw new BadRequestException('No store resolved for this action');
    return first;
  }

  /**
   * Resolve who an action is for and in which store. Defaults to the current user;
   * a manager+ may target another staff member (by user id) within their scope.
   */
  private async resolveActor(
    user: AuthUser,
    headerStore: string | undefined,
    staffId?: string,
  ): Promise<{ staffId: string; staffName: string | null; storeId: string }> {
    if (staffId && staffId !== user.id) {
      if (ROLE_RANK[user.role] < ROLE_RANK.store_manager) {
        throw new ForbiddenException('Only managers may act on behalf of other staff');
      }
      const target = await this.prisma.user.findUnique({
        where: { id: staffId },
        include: { userStores: true },
      });
      if (!target) throw new NotFoundException('Staff not found');
      const storeId = this.resolveStoreId(
        user,
        headerStore,
        target.userStores.map((s) => s.storeId),
      );
      this.scope.assertStoreAllowed(user, storeId);
      return { staffId: target.id, staffName: target.name, storeId };
    }
    const storeId = this.resolveStoreId(user, headerStore, user.storeIds);
    this.scope.assertStoreAllowed(user, storeId);
    return { staffId: user.id, staffName: user.name, storeId };
  }
}
