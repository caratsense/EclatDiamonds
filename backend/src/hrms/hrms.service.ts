import { Injectable, NotFoundException } from '@nestjs/common';
import { AttendanceStatus, LeaveStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import {
  CreateHolidayDto,
  CreateShiftDto,
  MarkAttendanceDto,
  SetWeekOffDto,
} from './dto/hrms.dto';

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

  /** PATCH /hrms/leave/:id — approve/reject a leave request. */
  async decideLeave(user: AuthUser, id: string, status: LeaveStatus) {
    const existing = await this.prisma.leaveRequest.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
    });
    if (!existing) throw new NotFoundException('Leave request not found');
    const row = await this.prisma.leaveRequest.update({ where: { id }, data: { status } });
    return this.toLeaveView(row);
  }

  private toLeaveView(r: any) {
    const days =
      Math.round((r.toDate.getTime() - r.fromDate.getTime()) / 86400000) + 1;
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

    return commissions.map((c) => ({
      staffId: c.userId,
      name: c.user.name,
      initials: c.user.initials ?? initialsOf(c.user.name),
      role: 'Sales Executive',
      storeId: c.storeId ?? c.user.userStores[0]?.storeId ?? '',
      salesValue: num(c.salesValue),
      rate: num(c.rate) / 100,
      incentive: num(c.amount),
      target: Math.round(num(c.salesValue) * 0.85),
    }));
  }
}
