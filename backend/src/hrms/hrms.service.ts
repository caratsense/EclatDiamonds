import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AttendanceStatus, LeaveStatus, LeaveType, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { AuditService } from '../common/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService } from '../storage/storage.service';
import { saveCapturedPhoto } from '../storage/capture-photo';
import { ROLE_LABELS, ROLE_RANK, isFrontLine } from '../common/role.util';
import { PayrollService } from './payroll.service';
import {
  AttendanceOpsService,
  ATTENDANCE_CALCULATION_VERSION,
  addDays,
  assertCanCorrect,
  assertCanCorrectUser,
  assertMonthOpen,
  classifyDay,
  eligibleStaff,
  instantFromUnambiguousLocal,
  recordPunch,
  resolveShiftFor,
  seedLedgerFromRow,
  shiftFromSnapshot,
  snapshotShift,
  shiftDayMaths,
  shiftEarlyOut,
  shiftLateness,
  supersedePunches,
  toHolidayView,
  toShiftView,
} from './attendance-ops.service';
import {
  assertNotSelfApproval,
  assertUndecided,
  decisionStamp,
} from '../common/approval.util';
import {
  businessDate,
  dateOnly,
  formatHHMMInTz,
  instantFromLocalTime,
  parseHHMM,
  resolveTz,
  shiftDurationMins,
  shiftEndMinutesOfDay,
} from '../common/tz.util';
import {
  ApplyLeaveDto,
  AttendanceReportQueryDto,
  CheckInDto,
  CheckOutDto,
  CreateHolidayDto,
  CreateRegularizationDto,
  CreateShiftDto,
  CreateLeaveBalanceDto,
  DayCloseDto,
  EditLeaveDto,
  MarkAttendanceDto,
  RegisterQueryDto,
  SetWeekOffDto,
  UpdateAttendanceDto,
  UpdateLeaveBalanceDto,
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
  // Granted per person (EzAttendance "K": one day a week for store staff
  // with no fixed weekly off), never by default.
  week_off_leave: 0,
};

/** Balance-tracked (paid) leave types: applied against a per-year LeaveBalance. */
const PAID_LEAVE_TYPES: LeaveType[] = ['casual', 'sick', 'earned', 'week_off_leave'];

/** Leave states that can no longer be approved/rejected. */
const LEAVE_TERMINAL: readonly string[] = ['approved', 'rejected', 'cancelled'];

/** Attendance states that mean "not a working day" — never counted as absence. */
const NON_WORKING_STATUSES: AttendanceStatus[] = ['week_off', 'holiday', 'on_leave'];

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
  week_off_leave: 'Week-off leave',
};

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

/** Haversine distance in metres. Callers guard on both coordinate pairs existing. */
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

/** Parse a YYYY-MM-DD (or ISO) date string to its UTC-midnight Date (@db.Date). */
function parseDateOnly(s: string): Date {
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
 * Indian financial year (Apr 1 – Mar 31) that a date belongs to, returned as the
 * STARTING calendar year — the int stored in LeaveBalance.year. A date on/after
 * Apr 1 belongs to the FY starting that calendar year; Jan–Mar belongs to the FY
 * that started the previous calendar year (so allocations reset in April, not January).
 */
function financialYear(d: Date): number {
  const y = d.getUTCFullYear();
  return d.getUTCMonth() >= 3 ? y : y - 1; // getUTCMonth() is 0-based; 3 = April
}

/** Human FY label from its starting calendar year, e.g. 2026 -> "2026–27". */
function financialYearLabel(fyStart: number): string {
  return `${fyStart}–${String((fyStart + 1) % 100).padStart(2, '0')}`;
}

/** The store facts every attendance calculation needs, resolved once per call. */
interface StoreCtx {
  id: string;
  name: string;
  tz: string;
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusM: number;
  weekOffDay: number | null;
}

/**
 * Where a client should ASK for a punch photo.
 *
 * Deliberately not the object's own URL. That URL is served either by express
 * static — which runs ahead of every guard in this application — or by a
 * public-read bucket, so handing it out makes a photograph of an employee's
 * face readable by anyone who ever sees the link. This route checks the caller
 * against the record first. See `AttendancePhotoService`.
 *
 * Null when there is no photo, so "no photo was taken" stays distinguishable
 * from "there is one, go and fetch it".
 */
function photoRoute(recordId: string, which: 'in' | 'out', stored: string | null): string | null {
  return stored ? `/hrms/attendance/${recordId}/photo/${which}` : null;
}

@Injectable()
export class HrmsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly storage: StorageService,
    private readonly payroll: PayrollService,
    private readonly ops: AttendanceOpsService,
  ) {}

  /**
   * Store a punch photo and return its URL, or null when there is nothing
   * storable.
   *
   * Never throws. A punch must not fail because a camera frame was malformed or
   * object storage was having a bad minute — the attendance record is the thing
   * that matters, and the photo is corroboration. A failure is logged and the
   * punch proceeds without it, which is honest: the row then simply has no
   * photo, rather than a broken link that looks like evidence.
   *
   * Only real raster images are accepted, decoded from the declared MIME type
   * rather than trusted: `data:` is a URL scheme, and anyone can put anything
   * after the comma.
   */
  /**
   * Store a punch photo, or return null when there is nothing storable.
   *
   * The rules live in `saveCapturedPhoto` because the counter-visit screen needs
   * exactly the same ones. Never throws: the attendance record matters more than
   * the picture beside it.
   */
  private savePunchPhoto(user: AuthUser, kind: 'in' | 'out', photo: string | undefined) {
    return saveCapturedPhoto(
      this.storage,
      user.organisationId,
      'attendance',
      `${user.id}-${kind}-${Date.now()}`,
      photo,
    );
  }

  /**
   * Load the store facts attendance depends on, with its IANA timezone resolved
   * (falling back to the platform default if a row carries a bad value).
   *
   * Everything downstream — the business date a punch belongs to, whether it is
   * late, which day is the weekly off — is computed in THIS zone. The previous
   * implementation compared UTC clock components against store-local "HH:MM"
   * shift strings, which in IST offset every punch by 5h30m: a 10:00 arrival read
   * as 04:30, so `isLate` could never fire for a morning shift and every punch
   * time rendered five and a half hours early.
   */
  private async storeCtx(storeId: string): Promise<StoreCtx> {
    const store = await this.prisma.store.findUnique({ where: { id: storeId } });
    if (!store) throw new NotFoundException('Store not found');
    return {
      id: store.id,
      name: store.name,
      tz: resolveTz(store.timezone),
      latitude: store.latitude != null ? num(store.latitude) : null,
      longitude: store.longitude != null ? num(store.longitude) : null,
      geofenceRadiusM: store.geofenceRadiusM ?? 150,
      weekOffDay: store.weekOffDay,
    };
  }

  /** Timezone lookup for a set of stores, for list endpoints that span branches. */
  private async tzByStore(storeIds: string[]): Promise<Map<string, string>> {
    if (storeIds.length === 0) return new Map();
    const stores = await this.prisma.store.findMany({
      where: { id: { in: storeIds } },
      select: { id: true, timezone: true },
    });
    return new Map(stores.map((s) => [s.id, resolveTz(s.timezone)]));
  }

  /**
   * Geofence evaluation for one punch.
   *
   * A check-IN outside a CONFIGURED fence is BLOCKED (sheet: "punch-in shouldn't
   * be allowed if geo-fencing is breached") — it can't be recorded as on-time
   * from across town. Check-OUT is more lenient: someone who walked off before
   * punching out isn't stranded — it's recorded with a written reason and lands
   * in the manager's review queue.
   *
   * SAFETY: when the store has no coordinates configured there is nothing to
   * verify against, so the punch is allowed but explicitly left unverified —
   * a missing fence must never lock staff out or manufacture GPS assurance.
   */
  private evaluateFence(
    store: StoreCtx,
    lat: number | undefined,
    lng: number | undefined,
    note: string | undefined,
    kind: 'check-in' | 'check-out',
    accuracyM?: number,
  ): { distanceM: number | null; withinFence: boolean } {
    if (store.latitude == null || store.longitude == null) {
      // No geofence configured for this store — nothing to verify against, so
      // never block or flag. The fence is enforced only when it's actually set.
      // Allow the punch, but never manufacture verification when no fence is configured.
      return { distanceM: null, withinFence: false };
    }
    if (lat == null || lng == null) {
      // The device produced no fix. There is nothing to measure, and "my GPS
      // wasn't working" is exactly how a buddy punch would be dressed up — so it
      // is recorded, but it has to be explained. Clients must OMIT the
      // coordinates here rather than sending 0/0: Null Island is a real place
      // 8,200 km from Mumbai, and it reads as a wildly out-of-fence punch.
      if (!note?.trim()) {
        throw new BadRequestException(
          `Your location is unavailable, so this ${kind} can't be checked against ${store.name}. Add a reason to record it — your manager will review it.`,
        );
      }
      return { distanceM: null, withinFence: false };
    }
    const dist = haversineM(store.latitude, store.longitude, lat, lng);
    /*
     * HOW SURE IS THE FIX. A phone indoors can report a position with a radius
     * of uncertainty of several hundred metres. Such a fix can neither confirm
     * someone is inside a 150 m fence nor prove they are outside it, and
     * pretending either way is the failure: blocking a person standing at the
     * counter, or waving through a punch from down the road. When the reported
     * uncertainty reaches the far side of the fence the punch is not decided by
     * GPS at all — it needs a reason and goes to the manager, exactly like a
     * punch with no fix. This is not anti-spoofing; a spoofed position reports
     * whatever accuracy it likes.
     */
    const uncertain =
      accuracyM != null &&
      Number.isFinite(accuracyM) &&
      accuracyM > 0 &&
      dist <= store.geofenceRadiusM + accuracyM &&
      (accuracyM > store.geofenceRadiusM || dist > store.geofenceRadiusM);
    if (uncertain) {
      if (!note?.trim()) {
        throw new BadRequestException(
          `Your location is only accurate to about ${Math.round(accuracyM!)} m, which cannot confirm this ${kind} is within ${store.geofenceRadiusM} m of ${store.name}. Move near a window or outdoors and try again, or add a reason — your manager will review it.`,
        );
      }
      return { distanceM: Math.round(dist), withinFence: false };
    }
    const withinFence = dist <= store.geofenceRadiusM;
    if (!withinFence && kind === 'check-in') {
      // A CONFIDENT fix outside the fence: the person is not at the store, and
      // a typed reason does not change where they are. Refused outright — a
      // note only rescues the cases GPS cannot decide (no fix, or a fix too
      // vague to tell), which are handled above and go to the manager.
      throw new BadRequestException(
        `You're ${Math.round(dist)} m from ${store.name} (allowed: ${store.geofenceRadiusM} m). You must be at the store to check in.`,
      );
    }
    if (!withinFence) {
      if (!note?.trim()) {
        throw new BadRequestException(
          `You're ${Math.round(dist)} m from ${store.name} (allowed: ${
            store.geofenceRadiusM
          } m). Add a reason or grace note to record it — your manager will review it.`,
        );
      }
    }
    return { distanceM: Math.round(dist), withinFence };
  }

  // ==========================================================================
  // Attendance — team views
  // ==========================================================================

  /** GET /hrms/attendance — recent attendance with geo-verification, store-scoped. */
  async attendance(user: AuthUser, headerStore?: string) {
    const where: Prisma.AttendanceRecordWhereInput = {
      ...this.scope.storeFilter(user, headerStore),
    };
    // Front-line staff (salesperson, storeperson) see only their OWN attendance;
    // store_manager+ see the team.
    if (isFrontLine(user.role)) where.staffId = user.id;
    const rows = await this.prisma.attendanceRecord.findMany({
      where,
      include: { store: true },
      orderBy: [{ date: 'desc' }, { staffName: 'asc' }],
      take: 200,
    });

    // Resolve the real shift label and the real staff role instead of the
    // hardcoded "Morning · 10:00–19:00" / "Sales Executive" the view used to emit.
    const [shifts, staff] = await Promise.all([
      this.prisma.shift.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.shiftId).filter(Boolean))] as string[] } },
      }),
      this.prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.staffId))] } },
        select: { id: true, role: true },
      }),
    ]);
    const shiftById = new Map(shifts.map((s) => [s.id, s]));
    const roleById = new Map(staff.map((s) => [s.id, s.role]));

    return rows.map((r) => this.toAttendanceView(r, shiftById, roleById));
  }

  /** Shape an AttendanceRecord (with its `store`) into the frontend attendance row. */
  private toAttendanceView(
    r: any,
    shiftById: Map<string, any>,
    roleById: Map<string, Role>,
  ) {
    const tz = resolveTz(r.store?.timezone);
    const shift = r.shiftId ? shiftById.get(r.shiftId) : null;
    const role = roleById.get(r.staffId);
    return {
      id: r.id,
      storeId: r.storeId,
      storeName: r.store?.name ?? null,
      staffId: r.staffId,
      date: dateOnly(r.date),
      name: r.staffName ?? r.staffId,
      initials: initialsOf(r.staffName),
      role: role ? ROLE_LABELS[role] : '—',
      shift: NON_WORKING_STATUSES.includes(r.status)
        ? '—'
        : shift
          ? `${shift.name} · ${shift.startTime}–${shift.endTime}`
          : 'Unassigned',
      checkIn: formatHHMMInTz(r.checkInAt, tz),
      checkOut: formatHHMMInTz(r.checkOutAt, tz),
      status: r.status,
      ping: {
        lat: r.checkInLat != null ? num(r.checkInLat) : null,
        lng: r.checkInLng != null ? num(r.checkInLng) : null,
      },
      distanceM: r.checkInDistanceM ?? null,
      withinFence: r.geoVerified,
      shiftId: r.shiftId ?? null,
      isLate: r.isLate ?? false,
      lateMinutes: r.lateMinutes ?? null,
      workedMins: r.workedMins ?? null,
      overtimeMins: r.overtimeMins ?? null,
      earlyOutMinutes: r.earlyOutMinutes ?? null,
      dayFraction: r.dayFraction != null ? num(r.dayFraction) : null,
      isMockLocation: r.isMockLocation ?? false,
      /*
       * The photo belongs with the other review signals, not one endpoint away.
       *
       * `distanceM`, `withinFence` and `isMockLocation` were all returned here
       * and rendered; the photo was returned on three OTHER endpoints and
       * rendered on none, so the one shape the manager's HRMS screen actually
       * reads could not show it at all. The evidence was collected and never
       * looked at.
       */
      checkInPhotoUrl: photoRoute(r.id, 'in', r.checkInPhotoUrl ?? null),
      checkOutPhotoUrl: photoRoute(r.id, 'out', r.checkOutPhotoUrl ?? null),
      checkInNote: r.checkInNote ?? null,
      checkOutNote: r.checkOutNote ?? null,
      source: r.source ?? 'self',
      autoClosed: r.autoClosed ?? false,
      /// Anything a manager should eyeball: off-site punch, spoofed GPS, or a
      /// day the system had to close on the staffer's behalf.
      needsReview:
        (!r.geoVerified && r.checkInAt != null) ||
        (r.isMockLocation ?? false) ||
        (r.autoClosed ?? false),
    };
  }

  /**
   * POST /hrms/attendance — a manager marks attendance for a staff member
   * (tablet / back-office correction). Manager+ only, per the controller gate.
   *
   * Three changes from the previous behaviour, all of them data-integrity fixes:
   *   - it UPSERTS on `[storeId, staffId, date]` instead of blind-creating, so a
   *     second mark for the same day corrects the row rather than exploding on
   *     the unique index;
   *   - `staffId` is now required and must resolve to a real user in the store,
   *     instead of falling back to a synthetic `att-<timestamp>` that created an
   *     untraceable ghost staff member on every call;
   *   - the day is keyed by the STORE's calendar date, not the API server's.
   */
  async markAttendance(user: AuthUser, dto: MarkAttendanceDto) {
    // Head office is view-only for attendance. The controller gate is
    // @Roles('store_manager','head_office') and rank rolls up, so HO would slip
    // through — it must be rejected explicitly here (a rank floor can't carve
    // out the top role). Store managers mark for their team; HO only observes.
    if (user.role === 'head_office') {
      throw new ForbiddenException(
        'Head office is view-only for attendance and cannot mark attendance.',
      );
    }
    this.scope.assertStoreAllowed(user, dto.storeId);
    const store = await this.storeCtx(dto.storeId);

    const target = await this.prisma.user.findUnique({
      where: { id: dto.staffId },
      include: { userStores: true },
    });
    if (!target) throw new NotFoundException('Staff not found');
    if (!target.userStores.some((s) => s.storeId === dto.storeId)) {
      throw new BadRequestException('Staff is not assigned to this store');
    }
    assertCanCorrect(user, target.id, target.role);

    if (dto.checkInAt && dto.checkInLocal) {
      throw new BadRequestException('Send either `checkInAt` or `checkInLocal`, not both.');
    }
    const suppliedInstant = dto.checkInAt ? new Date(dto.checkInAt) : null;
    if (suppliedInstant && Number.isNaN(suppliedInstant.getTime())) {
      throw new BadRequestException('Invalid check-in time');
    }
    const now = new Date();
    const date = dto.date
      ? parseDateOnly(dto.date)
      : businessDate(suppliedInstant ?? now, store.tz);
    const attended =
      dto.status === 'present' || dto.status === 'late' || dto.status === 'half_day';
    if (!attended && (dto.checkInAt || dto.checkInLocal || dto.shiftId)) {
      throw new BadRequestException(
        `A day marked ${dto.status} cannot carry a check-in time or shift.`,
      );
    }
    const shift = attended
      ? await resolveShiftFor(this.prisma, dto.storeId, target.id, date, dto.shiftId)
      : null;
    // Existing clients may mark a past day as present without supplying a
    // wall-clock time. Use that day's shift start (or local noon when no shift
    // exists), never "now" attached to a historical date.
    const checkInAt = dto.checkInLocal
      ? instantFromUnambiguousLocal(dateOnly(date), dto.checkInLocal, store.tz)
      : suppliedInstant ??
        (dto.date && attended
          ? instantFromUnambiguousLocal(dateOnly(date), shift?.startTime ?? '12:00', store.tz)
          : now);
    const today = businessDate(now, store.tz);
    if (date > today) throw new BadRequestException('Cannot mark attendance for a future date.');
    if (attended && dateOnly(businessDate(checkInAt, store.tz)) !== dateOnly(date)) {
      throw new BadRequestException(
        'The check-in time must belong to the attendance date in the store timezone.',
      );
    }
    if (attended && checkInAt.getTime() > now.getTime() + 5 * 60_000) {
      throw new BadRequestException('A check-in cannot be in the future.');
    }
    await assertMonthOpen(this.prisma, user.organisationId, date);

    let status: AttendanceStatus = dto.status;
    const shiftId = shift?.id ?? null;
    let isLate = false;
    let lateMinutes: number | null = null;

    // Lateness only makes sense for a day someone actually attended.
    if (attended && shift) {
      const late = shiftLateness(checkInAt, shift, store.tz);
      isLate = late.isLate;
      lateMinutes = late.lateMinutes;
      if (status !== 'half_day') status = isLate ? 'late' : 'present';
    }

    const data = {
      staffName: target.name,
      status,
      checkInAt: attended ? checkInAt : null,
      shiftId,
      isLate,
      lateMinutes,
      dayFraction: attended ? (status === 'half_day' ? 0.5 : 1) : 0,
      source: 'manager',
      calculationVersion: ATTENDANCE_CALCULATION_VERSION,
      shiftSnapshot: shift ? snapshotShift(shift) : Prisma.DbNull,
    };

    const row = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.attendanceRecord.upsert({
        where: { storeId_staffId_date: { storeId: dto.storeId, staffId: target.id, date } },
        update: data,
        create: {
          organisationId: user.organisationId,
          storeId: dto.storeId,
          staffId: target.id,
          date,
          ...data,
        },
        include: { store: true },
      });

      // The register and evidence ledger are one atomic fact: neither may exist
      // without the other if a ledger append or void fails.
      await supersedePunches(tx, {
        userId: target.id,
        storeId: dto.storeId,
        date,
        tz: store.tz,
        kinds: attended ? ['in'] : ['in', 'out'],
        actorId: user.id,
      });
      if (attended) {
        await recordPunch(tx, {
          organisationId: user.organisationId,
          userId: target.id,
          storeId: dto.storeId,
          kind: 'in',
          eventAt: checkInAt,
          source: 'manager',
          idempotencyKey: `manager:${saved.id}:in:${checkInAt.toISOString()}`,
          note: `Marked ${status} by ${user.name}`,
          createdById: user.id,
        });
      }
      return saved;
    });

    // Marking someone else's attendance is a payroll-affecting act by a third
    // party — it belongs in the trail even when nothing looks suspicious.
    await this.audit.record(user, {
      action: 'attendance.manager_mark',
      entityType: 'AttendanceRecord',
      entityId: row.id,
      storeId: row.storeId,
      summary: `Marked ${target.name} as ${status} on ${dateOnly(date)}`,
      metadata: { staffId: target.id, status, shiftId, source: 'manager' },
    });
    // A mark on a day whose payslip was already issued is a late correction:
    // the slip is flagged, never rewritten.
    await this.payroll.recheckIssued(target.id, date);

    const shiftById = new Map(shift && shiftId ? [[shiftId, shift] as [string, any]] : []);
    return this.toAttendanceView(row, shiftById, new Map([[target.id, target.role]]));
  }

  // ==========================================================================
  // Attendance — self-service geo punch
  // ==========================================================================

  /**
   * POST /hrms/attendance/check-in — the current user punches in from their phone.
   *
   * The punch instant is stored in UTC; everything derived from it (the business
   * date it belongs to, whether it beat the shift's start + buffer) is resolved
   * in the STORE's timezone. An out-of-fence punch is recorded but requires a
   * written reason and is surfaced to the manager for review.
   */
  async checkIn(user: AuthUser, dto: CheckInDto, headerStore?: string) {
    // Head office is view-only for attendance — it sees store-wise data but does
    // not punch. The role-rank guards roll up (store_manager admits everything
    // higher), so HO must be excluded explicitly, not by a rank floor.
    if (user.role === 'head_office') {
      throw new ForbiddenException(
        'Head office is view-only for attendance and cannot punch in.',
      );
    }
    const storeId = this.resolveStoreId(user, headerStore, user.storeIds);
    this.scope.assertStoreAllowed(user, storeId);
    const store = await this.storeCtx(storeId);

    const now = new Date();
    const date = businessDate(now, store.tz);
    await assertMonthOpen(this.prisma, user.organisationId, date);

    const { distanceM, withinFence } = this.evaluateFence(
      store,
      dto.lat,
      dto.lng,
      dto.note,
      'check-in',
      dto.accuracyM,
    );

    // Lateness vs the shift given, else the one assigned for today, else the
    // store's first shift. Never for a flexible shift.
    const shift = await resolveShiftFor(this.prisma, storeId, user.id, date, dto.shiftId);
    let shiftId: string | null = null;
    let isLate = false;
    let lateMinutes: number | null = null;
    if (shift) {
      const late = shiftLateness(now, shift, store.tz);
      isLate = late.isLate;
      lateMinutes = late.lateMinutes;
      shiftId = shift.id;
    }

    const photoUrl = await this.savePunchPhoto(user, 'in', dto.photo);

    const payload = {
      checkInAt: now,
      checkInLat: dto.lat,
      checkInLng: dto.lng,
      checkInPhotoUrl: photoUrl,
      geoVerified: withinFence,
      checkInDistanceM: distanceM,
      checkInNote: dto.note?.trim() || null,
      isMockLocation: dto.isMockLocation ?? false,
      status: (isLate ? 'late' : 'present') as AttendanceStatus,
      shiftId,
      isLate,
      lateMinutes,
      source: 'self',
      autoClosed: false,
      calculationVersion: ATTENDANCE_CALCULATION_VERSION,
      shiftSnapshot: shift ? snapshotShift(shift) : Prisma.DbNull,
    };

    const row = await this.prisma
      .$transaction(async (tx) => {
        const current = await tx.attendanceRecord.findUnique({
          where: { storeId_staffId_date: { storeId, staffId: user.id, date } },
        });
        // Re-punching after a completed or manager-classified day would erase
        // payroll evidence. The conditional update below is also the race
        // guard: two tabs cannot both claim the same empty row.
        if (current?.checkOutAt) {
          throw new BadRequestException(
            'You have already completed today. Raise a regularization request to change your punches.',
          );
        }
        if (current?.checkInAt) {
          throw new BadRequestException('You are already checked in for today.');
        }
        if (
          current &&
          !(['present', 'late', 'half_day'] as AttendanceStatus[]).includes(current.status)
        ) {
          throw new BadRequestException(
            `Today is already marked ${current.status}. Ask a manager to correct it.`,
          );
        }

        let saved;
        if (current) {
          const claimed = await tx.attendanceRecord.updateMany({
            where: { id: current.id, checkInAt: null, checkOutAt: null },
            data: payload,
          });
          if (claimed.count !== 1) {
            throw new BadRequestException('You are already checked in for today.');
          }
          saved = await tx.attendanceRecord.findUniqueOrThrow({ where: { id: current.id } });
        } else {
          saved = await tx.attendanceRecord.create({
            data: {
              organisationId: user.organisationId,
              storeId,
              staffId: user.id,
              staffName: user.name,
              date,
              ...payload,
            },
          });
        }
        await recordPunch(tx, {
          organisationId: user.organisationId,
          userId: user.id,
          storeId,
          kind: 'in',
          eventAt: now,
          source: 'self',
          idempotencyKey: `self:${user.id}:in:${now.toISOString()}`,
          lat: dto.lat,
          lng: dto.lng,
          accuracyM: dto.accuracyM,
          note: payload.checkInNote,
          createdById: user.id,
        });
        return saved;
      })
      .catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new BadRequestException('You are already checked in for today.');
        }
        throw error;
      });

    // A punch away from the store, or one from a device reporting a mock GPS
    // provider, is the classic buddy-punching signature — trail it immediately
    // rather than relying on someone opening the report.
    if (!withinFence || payload.isMockLocation) {
      await this.audit.record(user, {
        action: 'attendance.offsite_punch',
        entityType: 'AttendanceRecord',
        entityId: row.id,
        storeId,
        summary: `${user.name} checked in ${
          distanceM != null ? `${distanceM} m from` : 'with no geofence set for'
        } ${store.name}${payload.isMockLocation ? ' (mock location reported)' : ''}`,
        metadata: { distanceM, isMockLocation: payload.isMockLocation, note: payload.checkInNote },
      });
    }

    return this.toSelfAttendanceView(row, store.tz);
  }

  /**
   * POST /hrms/attendance/check-out — the current user punches out.
   *
   * Records the check-out geo-fix, worked minutes, and — new here — early
   * departure, overtime and the payroll day credit. Because the day is resolved
   * in the store's timezone, a night batch that finishes after local midnight
   * still closes the shift it opened rather than reporting "no check-in found".
   */
  async checkOut(user: AuthUser, dto: CheckOutDto, headerStore?: string) {
    // Head office is view-only for attendance (see checkIn) — it never punches.
    if (user.role === 'head_office') {
      throw new ForbiddenException(
        'Head office is view-only for attendance and cannot punch out.',
      );
    }
    const storeId = this.resolveStoreId(user, headerStore, user.storeIds);
    this.scope.assertStoreAllowed(user, storeId);
    const store = await this.storeCtx(storeId);

    const now = new Date();
    const today = businessDate(now, store.tz);

    // Look at today first, then yesterday: a night batch punching out at 02:00
    // local is on the NEXT business date from the shift it started.
    const yesterday = new Date(today);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    const record =
      (await this.prisma.attendanceRecord.findFirst({
        where: { staffId: user.id, storeId, date: today, checkInAt: { not: null } },
      })) ??
      (await this.prisma.attendanceRecord.findFirst({
        where: {
          staffId: user.id,
          storeId,
          date: yesterday,
          checkInAt: { not: null },
          checkOutAt: null,
        },
      }));

    if (!record?.checkInAt) {
      throw new BadRequestException('No check-in found for today');
    }
    if (record.checkOutAt) {
      throw new BadRequestException('You have already checked out for this shift.');
    }
    await assertMonthOpen(this.prisma, user.organisationId, record.date);

    const { distanceM, withinFence } = this.evaluateFence(
      store,
      dto.lat,
      dto.lng,
      dto.note,
      'check-out',
      dto.accuracyM,
    );

    const frozenShift = shiftFromSnapshot(record.shiftSnapshot);
    const liveShift =
      !frozenShift && record.shiftId
        ? await resolveShiftFor(this.prisma, storeId, null, null, record.shiftId).catch(() => null)
        : null;
    const shift = frozenShift ?? liveShift;
    const workedMins = Math.round((now.getTime() - record.checkInAt.getTime()) / 60000);
    const { dayFraction, overtimeMins } = shiftDayMaths(workedMins, shift);

    const outPhotoUrl = await this.savePunchPhoto(user, 'out', dto.photo);

    const row = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.attendanceRecord.updateMany({
        where: { id: record.id, checkOutAt: null },
        data: {
          checkOutAt: now,
          checkOutLat: dto.lat,
          checkOutLng: dto.lng,
          checkOutPhotoUrl: outPhotoUrl,
          checkOutDistanceM: distanceM,
          checkOutVerified: withinFence,
          checkOutNote: dto.note?.trim() || null,
          workedMins,
          earlyOutMinutes: shiftEarlyOut(now, shift, store.tz),
          overtimeMins,
          // A short day is a half day for payroll, but the lateness flag it may
          // also carry is preserved independently on `isLate`.
          status: dayFraction != null && dayFraction < 1 ? 'half_day' : record.status,
          dayFraction,
          calculationVersion: record.calculationVersion ?? ATTENDANCE_CALCULATION_VERSION,
          shiftSnapshot: snapshotShift(shift),
        },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException('You have already checked out for this shift.');
      }
      const saved = await tx.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } });
      await recordPunch(tx, {
        organisationId: user.organisationId,
        userId: user.id,
        storeId,
        kind: 'out',
        eventAt: now,
        source: 'self',
        idempotencyKey: `self:${user.id}:out:${now.toISOString()}`,
        lat: dto.lat,
        lng: dto.lng,
        accuracyM: dto.accuracyM,
        note: dto.note?.trim() || null,
        createdById: user.id,
      });
      return saved;
    });

    return this.toSelfAttendanceView(row, store.tz);
  }

  /** GET /hrms/attendance/me?month=YYYY-MM — the current user's own punches. */
  async myAttendance(user: AuthUser, month?: string, headerStore?: string) {
    const { start, end } = monthRange(month);
    const scopeFilter = this.scope.storeFilter(user, headerStore);
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    const tzMap = await this.tzByStore(storeIds);
    const primaryTz = tzMap.get(storeIds[0]) ?? resolveTz(undefined);
    const date = businessDate(new Date(), primaryTz);

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

    const tzOf = (storeId: string) => tzMap.get(storeId) ?? primaryTz;
    return {
      today: todayRow ? this.toSelfAttendanceView(todayRow, tzOf(todayRow.storeId)) : null,
      records: records.map((r) => this.toSelfAttendanceView(r, tzOf(r.storeId))),
      summary: this.summarizeReport(records),
    };
  }

  /** The self-service attendance view (my punches). */
  private toSelfAttendanceView(r: any, tz: string) {
    return {
      id: r.id,
      storeId: r.storeId,
      date: dateOnly(r.date),
      status: r.status,
      checkInAt: r.checkInAt,
      checkOutAt: r.checkOutAt,
      /// Pre-formatted in the STORE's zone so a device roaming on another
      /// timezone still shows the staffer the clock their store runs on.
      checkInLocal: formatHHMMInTz(r.checkInAt, tz),
      checkOutLocal: formatHHMMInTz(r.checkOutAt, tz),
      timezone: tz,
      checkInDistanceM: r.checkInDistanceM ?? null,
      checkInPhotoUrl: photoRoute(r.id, 'in', r.checkInPhotoUrl ?? null),
      checkOutPhotoUrl: photoRoute(r.id, 'out', r.checkOutPhotoUrl ?? null),
      checkOutDistanceM: r.checkOutDistanceM ?? null,
      withinFence: r.geoVerified,
      checkOutWithinFence: r.checkOutVerified ?? false,
      workedMins: r.workedMins ?? null,
      overtimeMins: r.overtimeMins ?? null,
      earlyOutMinutes: r.earlyOutMinutes ?? null,
      dayFraction: r.dayFraction != null ? num(r.dayFraction) : null,
      isLate: r.isLate ?? false,
      lateMinutes: r.lateMinutes ?? null,
      shiftId: r.shiftId ?? null,
      checkInNote: r.checkInNote ?? null,
      checkOutNote: r.checkOutNote ?? null,
      isMockLocation: r.isMockLocation ?? false,
      autoClosed: r.autoClosed ?? false,
      source: r.source ?? 'self',
    };
  }

  /**
   * GET /hrms/geofence — the caller's resolved store geofence, so the client can do
   * LIVE (client-side) distance checks and auto-punch when in range.
   */
  async geofence(user: AuthUser, headerStore?: string) {
    const storeId = this.resolveStoreId(user, headerStore, user.storeIds);
    this.scope.assertStoreAllowed(user, storeId);
    const store = await this.storeCtx(storeId);
    return {
      storeId: store.id,
      storeName: store.name,
      latitude: store.latitude,
      longitude: store.longitude,
      geofenceRadiusM: store.geofenceRadiusM,
      hasCoords: store.latitude != null && store.longitude != null,
      timezone: store.tz,
      /// The client must collect a reason before posting an out-of-fence punch —
      /// the API rejects one without it.
      requiresReasonOutsideFence: true,
    };
  }

  // ==========================================================================
  // Attendance — day close (absence marking + dangling-punch cleanup)
  // ==========================================================================

  /**
   * POST /hrms/attendance/day-close — close out a working day for a store.
   *
   * Without this step an attendance system only ever knows who DID turn up: a
   * staffer who simply never punched leaves no row at all, so absence is
   * invisible to payroll and to any report. This is the standard end-of-day
   * reconciliation, and it does three things for every staffer rostered to the
   * store:
   *
   *   - dangling punches (checked in, never checked out) are closed at the
   *     shift's scheduled end and flagged `autoClosed`, so worked-minutes stop
   *     growing forever and the staffer is prompted to regularize;
   *   - staff with no row get one, classified as `week_off`, `holiday`,
   *     `on_leave` (from an approved leave request covering the date) or, failing
   *     all of those, `absent`;
   *   - nothing already recorded by a human is overwritten.
   *
   * Idempotent by construction, so a cron may safely call it more than once.
   */
  async dayClose(user: AuthUser, dto: DayCloseDto) {
    const storeId = dto.storeId;
    this.scope.assertStoreAllowed(user, storeId);
    const store = await this.storeCtx(storeId);

    // Default to the PREVIOUS store-local day: closing today mid-shift would mark
    // everyone still working as absent.
    const today = businessDate(new Date(), store.tz);
    let date: Date;
    if (dto.date) {
      date = parseDateOnly(dto.date);
      if (date > today) throw new BadRequestException('Cannot close a future date');
    } else {
      date = new Date(today);
      date.setUTCDate(date.getUTCDate() - 1);
    }

    await assertMonthOpen(this.prisma, user.organisationId, date);

    /*
     * Who is on the roster that day, with their leave / holiday / weekly-off
     * facts, comes from the same `eligibleStaff` the Today screen and the
     * reports use — so "absent" here and "absent" there are the same people.
     * (Weekly offs are per person, falling back to the branch's day; area
     * managers and head office are mapped for visibility, not rostered.)
     */
    const [assignments, records] = await Promise.all([
      eligibleStaff(this.prisma, user.organisationId, [storeId], date),
      this.prisma.attendanceRecord.findMany({ where: { storeId, date } }),
    ]);
    const byStaff = new Map(records.map((r) => [r.staffId, r]));

    let autoClosedCount = 0;
    let absentCount = 0;
    let leaveCount = 0;
    let nonWorkingCount = 0;

    for (const a of assignments) {
      const existing = byStaff.get(a.userId);

      if (existing) {
        if (existing.checkInAt && !existing.checkOutAt) {
          // Close at the shift's scheduled end, in store-local time.
          const frozenShift = shiftFromSnapshot(existing.shiftSnapshot);
          const liveShift = frozenShift
            ? null
            : existing.shiftId
              ? await resolveShiftFor(this.prisma, storeId, null, null, existing.shiftId).catch(() => null)
              : await resolveShiftFor(this.prisma, storeId, a.userId, date);
          const shift = frozenShift ?? liveShift;
          const closeAt = shift
            ? instantFromLocalTime(
                date,
                shiftEndMinutesOfDay(shift.startTime, shift.endTime),
                store.tz,
              )
            : null;
          // Never invent a check-out before the check-in itself.
          const effective =
            closeAt && closeAt > existing.checkInAt ? closeAt : existing.checkInAt;
          const workedMins = Math.round(
            (effective.getTime() - existing.checkInAt.getTime()) / 60000,
          );
          const { dayFraction, overtimeMins } = shiftDayMaths(workedMins, shift);
          await this.prisma.$transaction(async (tx) => {
            await tx.attendanceRecord.update({
            where: { id: existing.id },
            data: {
              checkOutAt: effective,
              workedMins,
              overtimeMins,
              dayFraction,
              status: dayFraction != null && dayFraction < 1 ? 'half_day' : existing.status,
              autoClosed: true,
              calculationVersion: existing.calculationVersion ?? ATTENDANCE_CALCULATION_VERSION,
                shiftSnapshot: snapshotShift(shift),
              checkOutNote:
                existing.checkOutNote ??
                'Auto-closed at shift end — no check-out recorded. Regularize if incorrect.',
            },
          });
            await recordPunch(tx, {
            organisationId: user.organisationId,
            userId: a.userId,
            storeId,
            kind: 'out',
            eventAt: effective,
            source: 'auto',
            idempotencyKey: `auto:${existing.id}:out`,
              note: 'Auto-closed at shift end by the day close.',
            });
          });
          autoClosedCount++;
        }
        continue; // A row that already exists is never reclassified.
      }

      const state = classifyDay(a, null).state;
      const status: AttendanceStatus = state === 'not_marked' ? 'absent' : state;
      if (status === 'absent') absentCount++;
      else if (status === 'on_leave') leaveCount++;
      else nonWorkingCount++;

      await this.prisma.attendanceRecord.create({
        data: {
          organisationId: user.organisationId,
          storeId,
          staffId: a.userId,
          staffName: a.name,
          date,
          status,
          dayFraction: status === 'absent' ? 0 : null,
          source: 'auto',
          calculationVersion: ATTENDANCE_CALCULATION_VERSION,
        },
      });
    }

    const result = {
      storeId,
      date: dateOnly(date),
      timezone: store.tz,
      staffConsidered: assignments.length,
      autoClosed: autoClosedCount,
      markedAbsent: absentCount,
      markedOnLeave: leaveCount,
      markedNonWorking: nonWorkingCount,
    };

    await this.audit.record(user, {
      action: 'attendance.day_close',
      entityType: 'Store',
      entityId: storeId,
      storeId,
      summary: `Closed attendance for ${store.name} on ${result.date}: ${absentCount} absent, ${autoClosedCount} auto-closed`,
      metadata: result,
    });

    return result;
  }

  // ==========================================================================
  // Shifts / holidays / week-off
  // ==========================================================================

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
    const scheduled = shiftDurationMins(dto.startTime, dto.endTime);
    if (dto.fullDayMins != null && dto.fullDayMins > scheduled) {
      throw new BadRequestException(
        `A full day (${dto.fullDayMins} min) cannot exceed the shift's own length (${scheduled} min)`,
      );
    }
    if (dto.halfDayMins != null && dto.halfDayMins > (dto.fullDayMins ?? scheduled)) {
      throw new BadRequestException('Half-day threshold cannot exceed the full-day threshold');
    }
    const row = await this.prisma.shift.create({
      data: {
        organisationId: user.organisationId,
        storeId: dto.storeId,
        name: dto.name,
        startTime: dto.startTime,
        endTime: dto.endTime,
        bufferMins: dto.bufferMins ?? 15,
        isNightBatch: dto.isNightBatch ?? false,
        fullDayMins: dto.fullDayMins ?? null,
        halfDayMins: dto.halfDayMins ?? null,
        isFlexible: dto.isFlexible ?? false,
        code: dto.code?.trim() || null,
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
    const date = parseDateOnly(dto.date);
    await assertMonthOpen(this.prisma, user.organisationId, date);
    const row = await this.prisma.storeHoliday.upsert({
      where: { storeId_date: { storeId: dto.storeId, date } },
      update: { label: dto.label ?? null },
      create: { organisationId: user.organisationId, storeId: dto.storeId, date, label: dto.label ?? null },
    });
    return toHolidayView(row);
  }

  /** PATCH /hrms/week-off — set a store's weekly off day (HO/area only). */
  async setWeekOff(user: AuthUser, dto: SetWeekOffDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);
    const existing = await this.prisma.store.findUnique({ where: { id: dto.storeId } });
    if (!existing) throw new NotFoundException('Store not found');
    // Old locked payroll periods must not make the branch setting immutable
    // forever. The setting takes effect now, so protect the current local
    // payroll month; historical issued slips are already frozen.
    await assertMonthOpen(
      this.prisma,
      user.organisationId,
      businessDate(new Date(), resolveTz(existing.timezone)),
    );
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

  // ==========================================================================
  // Attendance — reports
  // ==========================================================================

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

    const [grouped, attended] = await Promise.all([
      this.prisma.attendanceRecord.groupBy({
        by: ['staffId', 'staffName', 'storeId'],
        // A colleague's lateness is a manager's business; front-line staff see their own.
        where: {
          storeId: { in: storeIds },
          isLate: true,
          date: { gte: start, lt: end },
          ...(isFrontLine(user.role) ? { staffId: user.id } : {}),
        },
        _count: { _all: true },
      }),
      // Denominator for punctuality: days the staffer actually attended.
      this.prisma.attendanceRecord.groupBy({
        by: ['staffId'],
        where: {
          storeId: { in: storeIds },
          date: { gte: start, lt: end },
          status: { in: ['present', 'late', 'half_day'] },
        },
        _count: { _all: true },
      }),
    ]);

    const attendedByStaff = new Map(attended.map((a) => [a.staffId, a._count._all]));

    const staff = grouped
      .map((g) => {
        const days = attendedByStaff.get(g.staffId) ?? g._count._all;
        return {
          staffId: g.staffId,
          staffName: g.staffName ?? g.staffId,
          storeId: g.storeId,
          lateCount: g._count._all,
          attendedDays: days,
          /// Share of attended days the staffer arrived on time, 0–100.
          punctualityPct: days > 0 ? Math.round(((days - g._count._all) / days) * 100) : 100,
          flagged: g._count._all >= 3,
        };
      })
      .sort((a, b) => b.lateCount - a.lateCount);

    return { month: label, note, staff };
  }

  /**
   * GET /hrms/attendance/report — a user's attendance + GPS history over a date
   * range (EzAttendancePro "Attendance Report" + "GPS Report"). Self by default;
   * a store_manager+ may pass `staffId` for anyone in their store scope.
   */
  async attendanceReport(user: AuthUser, query: AttendanceReportQueryDto, headerStore?: string) {
    const from = parseDateOnly(query.from);
    const to = parseDateOnly(query.to);
    if (to < from) throw new BadRequestException('`to` must be on or after `from`');
    const spanDays = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
    if (spanDays > 92) {
      throw new BadRequestException('Date range too large (max 92 days)');
    }

    const actor = await this.resolveActor(user, headerStore, query.staffId);

    // `to` is inclusive; records are @db.Date UTC-midnights, so query [from, to+1day).
    const end = new Date(to);
    end.setUTCDate(end.getUTCDate() + 1);

    const rows = await this.prisma.attendanceRecord.findMany({
      where: {
        staffId: actor.staffId,
        date: { gte: from, lt: end },
        ...this.scope.storeFilter(user, headerStore),
      },
      orderBy: { date: 'desc' }, // newest-first
    });

    const tzMap = await this.tzByStore([...new Set(rows.map((r) => r.storeId))]);
    return {
      from: query.from,
      to: query.to,
      staffId: actor.staffId,
      records: rows.map((r) => this.toReportRow(r, tzMap.get(r.storeId) ?? resolveTz(undefined))),
      summary: this.summarizeReport(rows),
    };
  }

  /** One attendance row shaped for the EzAttendancePro report (GPS-aware, null-safe). */
  private toReportRow(r: any, tz: string) {
    return {
      date: dateOnly(r.date),
      status: r.status,
      checkInAt: r.checkInAt ? r.checkInAt.toISOString() : null,
      checkOutAt: r.checkOutAt ? r.checkOutAt.toISOString() : null,
      checkInLocal: formatHHMMInTz(r.checkInAt, tz),
      checkOutLocal: formatHHMMInTz(r.checkOutAt, tz),
      workedMins: r.workedMins ?? null,
      overtimeMins: r.overtimeMins ?? null,
      earlyOutMinutes: r.earlyOutMinutes ?? null,
      dayFraction: r.dayFraction != null ? num(r.dayFraction) : null,
      isLate: r.isLate ?? false,
      lateMinutes: r.lateMinutes ?? null,
      checkInLat: r.checkInLat != null ? num(r.checkInLat) : null,
      checkInLng: r.checkInLng != null ? num(r.checkInLng) : null,
      checkInDistanceM: r.checkInDistanceM ?? null,
      checkInPhotoUrl: photoRoute(r.id, 'in', r.checkInPhotoUrl ?? null),
      checkOutPhotoUrl: photoRoute(r.id, 'out', r.checkOutPhotoUrl ?? null),
      withinFence: r.geoVerified,
      checkInNote: r.checkInNote ?? null,
      isMockLocation: r.isMockLocation ?? false,
      autoClosed: r.autoClosed ?? false,
      source: r.source ?? 'self',
      shiftId: r.shiftId ?? null,
    };
  }

  /**
   * Roll a set of attendance rows into a period summary.
   *
   * Week-offs and holidays are counted separately and NEVER folded into
   * "present" — the old summary lumped every non-leave, non-absent status into
   * present, which inflated attendance the moment day-close started writing
   * `week_off` rows. `payableDays` is the sum of day credits and is what payroll
   * should read.
   */
  private summarizeReport(rows: any[]) {
    let present = 0;
    let halfDay = 0;
    let late = 0;
    let absent = 0;
    let onLeave = 0;
    let nonWorking = 0;
    let totalWorkedMins = 0;
    let totalOvertimeMins = 0;
    let workedDays = 0;
    let payableDays = 0;

    for (const r of rows) {
      switch (r.status) {
        case 'on_leave':
          onLeave++;
          break;
        case 'absent':
          absent++;
          break;
        case 'week_off':
        case 'holiday':
          nonWorking++;
          break;
        case 'half_day':
          halfDay++;
          break;
        default:
          present++; // 'present' or 'late' both count as a full attended day
      }
      if (r.isLate) late++; // lateness is tracked by the flag, independent of status
      if (r.workedMins != null) {
        totalWorkedMins += r.workedMins;
        workedDays++;
      }
      totalOvertimeMins += r.overtimeMins ?? 0;
      if (r.dayFraction != null) payableDays += Number(r.dayFraction);
      else if (r.status === 'present' || r.status === 'late') payableDays += 1;
      else if (r.status === 'half_day') payableDays += 0.5;
    }

    const attendedDays = present + halfDay;
    const scheduledDays = attendedDays + absent;
    return {
      present,
      halfDay,
      late,
      absent,
      onLeave,
      nonWorking,
      totalWorkedMins,
      totalOvertimeMins,
      avgWorkedMins: workedDays ? Math.round(totalWorkedMins / workedDays) : 0,
      payableDays: Math.round(payableDays * 100) / 100,
      /// Attended vs scheduled (week-offs/holidays excluded from the denominator).
      attendancePct: scheduledDays ? Math.round((attendedDays / scheduledDays) * 100) : 100,
      punctualityPct: attendedDays
        ? Math.round(((attendedDays - late) / attendedDays) * 100)
        : 100,
    };
  }

  /**
   * GET /hrms/attendance/team?date=YYYY-MM-DD — every staff member's punch for a day
   * within the caller's store scope (manager team-GPS / anti-buddy-punching view).
   */
  async teamAttendance(user: AuthUser, date?: string, headerStore?: string) {
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    const tzMap = await this.tzByStore(storeIds);
    const primaryTz = tzMap.get(storeIds[0]) ?? resolveTz(undefined);
    const day = date ? parseDateOnly(date) : businessDate(new Date(), primaryTz);

    const rows = await this.prisma.attendanceRecord.findMany({
      where: { date: day, ...this.scope.storeFilter(user, headerStore) },
      orderBy: [{ storeId: 'asc' }, { staffName: 'asc' }],
    });
    return rows.map((r) => {
      const tz = tzMap.get(r.storeId) ?? primaryTz;
      return {
        staffId: r.staffId,
        staffName: r.staffName ?? r.staffId,
        storeId: r.storeId,
        status: r.status,
        checkInAt: r.checkInAt ? r.checkInAt.toISOString() : null,
        checkOutAt: r.checkOutAt ? r.checkOutAt.toISOString() : null,
        checkInLocal: formatHHMMInTz(r.checkInAt, tz),
        checkOutLocal: formatHHMMInTz(r.checkOutAt, tz),
        workedMins: r.workedMins ?? null,
        overtimeMins: r.overtimeMins ?? null,
        isLate: r.isLate ?? false,
        lateMinutes: r.lateMinutes ?? null,
        checkInLat: r.checkInLat != null ? num(r.checkInLat) : null,
        checkInLng: r.checkInLng != null ? num(r.checkInLng) : null,
        checkInDistanceM: r.checkInDistanceM ?? null,
        checkInPhotoUrl: photoRoute(r.id, 'in', r.checkInPhotoUrl ?? null),
        checkOutPhotoUrl: photoRoute(r.id, 'out', r.checkOutPhotoUrl ?? null),
        withinFence: r.geoVerified,
        checkInNote: r.checkInNote ?? null,
        isMockLocation: r.isMockLocation ?? false,
        autoClosed: r.autoClosed ?? false,
        needsReview:
          (!r.geoVerified && r.checkInAt != null) || r.isMockLocation || r.autoClosed,
      };
    });
  }

  // ==========================================================================
  // Leave — apply / decide / cancel
  // ==========================================================================

  /** GET /hrms/leave — leave requests, store-scoped. */
  async leave(user: AuthUser, headerStore?: string) {
    const where: Prisma.LeaveRequestWhereInput = {
      ...this.scope.storeFilter(user, headerStore),
    };
    // A salesperson only ever sees their own leave history, never the team's.
    if (ROLE_RANK[user.role] < ROLE_RANK.store_manager) where.staffId = user.id;
    const rows = await this.prisma.leaveRequest.findMany({
      where,
      orderBy: { fromDate: 'desc' },
    });
    return rows.map((r) => this.toLeaveView(r));
  }

  /**
   * PATCH /hrms/leave/:id — approve/reject a leave request.
   *
   * Hardened in three ways over the previous implementation:
   *   - **Separation of duties.** A manager can no longer approve their own leave.
   *   - **Atomicity.** The balance movement and the status change now run in one
   *     transaction; previously a crash between them left the balance decremented
   *     against a request still showing as pending.
   *   - **Attribution.** The approver, timestamp and note are written onto the
   *     request itself, not just into the audit log.
   */
  async decideLeave(user: AuthUser, id: string, status: LeaveStatus, note?: string) {
    if (status !== 'approved' && status !== 'rejected') {
      throw new BadRequestException('A decision must be either approved or rejected');
    }

    const existing = await this.prisma.leaveRequest.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
    });
    if (!existing) throw new NotFoundException('Leave request not found');

    assertUndecided(existing.status, LEAVE_TERMINAL, 'leave request');
    assertNotSelfApproval(user, existing.staffId, 'leave request');
    await assertMonthOpen(this.prisma, user.organisationId, existing.fromDate, existing.toDate);

    const days = num(existing.days);
    const paid = PAID_LEAVE_TYPES.includes(existing.type) && days > 0;
    const year = financialYear(existing.fromDate);
    if (paid) await this.ensureLeaveBalances(existing.staffId, year, existing.storeId);

    const stamp = decisionStamp(user, note);
    const row = await this.prisma.$transaction(async (tx) => {
      if (paid && status === 'approved') {
        // Re-check the balance at DECISION time. Validation at apply time alone is
        // not enough: several requests can each pass it while pending and, taken
        // together, overdraw the allocation.
        const bal = await tx.leaveBalance.findUnique({
          where: { userId_type_year: { userId: existing.staffId, type: existing.type, year } },
        });
        const available = num(bal?.allocated) - num(bal?.used);
        if (available < days) {
          throw new BadRequestException(
            `Insufficient ${existing.type} balance: ${available} day(s) available, ${days} requested`,
          );
        }
        await tx.leaveBalance.update({
          where: { userId_type_year: { userId: existing.staffId, type: existing.type, year } },
          data: { used: { increment: days } },
        });
      }
      return tx.leaveRequest.update({ where: { id }, data: { status, ...stamp } });
    });

    await this.audit.record(user, {
      action: status === 'approved' ? 'leave.approve' : 'leave.reject',
      entityType: 'LeaveRequest',
      entityId: row.id,
      storeId: row.storeId,
      summary: `${status === 'approved' ? 'Approved' : 'Rejected'} ${row.type} leave for ${
        row.staffName ?? row.staffId
      }`,
      metadata: { from: existing.status, to: status, days, note: note ?? null },
    });

    await this.notifications.emit([row.staffId], {
      kind: 'leave_request',
      title: `Your ${row.type} leave was ${status}`,
      body: `${dateOnly(row.fromDate)} → ${dateOnly(row.toDate)} (${days} day(s)) — ${status} by ${
        user.name
      }${note?.trim() ? `: ${note.trim()}` : ''}`,
      href: '/hrms',
      storeId: row.storeId,
      entityType: 'LeaveRequest',
      entityId: row.id,
      priority: status === 'rejected' ? 'high' : 'normal',
      actorId: user.id,
      actorName: user.name,
      dedupeKey: `leave:${row.id}:decided`,
      metadata: { status, days },
    });

    return this.toLeaveView(row);
  }

  /**
   * PATCH /hrms/leave/:id/cancel — withdraw a request.
   *
   * The applicant may withdraw while it is still pending; a manager+ may also
   * revoke one that was already approved (plans change), which releases the days
   * back to the balance in the same transaction that flips the status.
   */
  async cancelLeave(user: AuthUser, id: string, reason?: string) {
    const existing = await this.prisma.leaveRequest.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
    });
    if (!existing) throw new NotFoundException('Leave request not found');

    const isOwner = existing.staffId === user.id;
    const isManager = ROLE_RANK[user.role] >= ROLE_RANK.store_manager;
    if (!isOwner && !isManager) {
      throw new ForbiddenException('You may only withdraw your own leave request');
    }
    if (existing.status === 'cancelled' || existing.status === 'rejected') {
      throw new BadRequestException(`This request is already ${existing.status}`);
    }
    if (existing.status === 'approved' && !isManager) {
      throw new ForbiddenException(
        'An approved leave can only be revoked by a manager — ask your manager to cancel it.',
      );
    }
    if (existing.status === 'approved') {
      await assertMonthOpen(this.prisma, user.organisationId, existing.fromDate, existing.toDate);
    }

    const days = num(existing.days);
    const releaseBalance =
      existing.status === 'approved' && PAID_LEAVE_TYPES.includes(existing.type) && days > 0;
    const year = financialYear(existing.fromDate);

    const row = await this.prisma.$transaction(async (tx) => {
      if (releaseBalance) {
        await tx.leaveBalance.update({
          where: { userId_type_year: { userId: existing.staffId, type: existing.type, year } },
          data: { used: { decrement: days } },
        });
      }
      return tx.leaveRequest.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          decisionNote: reason ?? existing.decisionNote,
        },
      });
    });

    await this.audit.record(user, {
      action: 'leave.cancel',
      entityType: 'LeaveRequest',
      entityId: row.id,
      storeId: row.storeId,
      summary: `Cancelled ${row.type} leave for ${row.staffName ?? row.staffId}`,
      metadata: { from: existing.status, days, balanceReleased: releaseBalance, reason: reason ?? null },
    });

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
      typeCode: r.type,
      from: fmt(r.fromDate),
      to: fmt(r.toDate),
      fromDate: dateOnly(r.fromDate),
      toDate: dateOnly(r.toDate),
      days,
      halfDay: r.halfDay ?? false,
      reason: r.reason ?? '',
      status: r.status,
      decidedBy: r.decidedByName ?? null,
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
      decisionNote: r.decisionNote ?? null,
    };
  }

  // ==========================================================================
  // Leave — balances
  // ==========================================================================

  /**
   * GET /hrms/leave/balances — self by default; a manager+ may pass a staffId within
   * scope. Auto-seeds the current financial year's default allocations on first read.
   */
  async leaveBalances(user: AuthUser, staffId?: string, headerStore?: string) {
    const actor = await this.resolveActor(user, headerStore, staffId);
    // Balances key on the Indian financial year (Apr–Mar), not the calendar year,
    // so allocations reset in April. Auto-seeds the FY row on first read.
    const year = financialYear(new Date());
    const label = financialYearLabel(year);
    await this.ensureLeaveBalances(actor.staffId, year, actor.storeId);

    const [rows, pending] = await Promise.all([
      this.prisma.leaveBalance.findMany({
        where: { userId: actor.staffId, year },
        orderBy: { type: 'asc' },
      }),
      // Days already committed to undecided requests. Showing only
      // allocated − used overstates what a staffer can still book.
      this.prisma.leaveRequest.groupBy({
        by: ['type'],
        where: { staffId: actor.staffId, status: 'pending' },
        _sum: { days: true },
      }),
    ]);
    const pendingByType = new Map(pending.map((p) => [p.type, num(p._sum.days)]));

    return rows.map((r) => {
      const allocated = num(r.allocated);
      const used = num(r.used);
      const reserved = pendingByType.get(r.type) ?? 0;
      return {
        id: r.id,
        type: r.type,
        label: LEAVE_TYPE_LABEL[r.type] ?? r.type,
        year: r.year,
        financialYearLabel: label,
        allocated,
        used,
        /// Days locked up in requests awaiting a decision.
        pending: reserved,
        balance: allocated - used,
        /// What can actually still be applied for, once pending requests are honoured.
        available: Math.max(0, allocated - used - reserved),
      };
    });
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
   *
   * Days default to inclusive working days (excluding the weekly off and any
   * configured holiday). Two guards were missing before: overlapping requests for
   * the same dates were accepted silently, and the balance check ignored days
   * already committed to other pending requests.
   */
  async applyLeave(user: AuthUser, dto: ApplyLeaveDto, headerStore?: string) {
    const actor = await this.resolveActor(user, headerStore, dto.staffId);
    const fromDate = parseDateOnly(dto.fromDate);
    const toDate = parseDateOnly(dto.toDate);
    if (toDate < fromDate) throw new BadRequestException('toDate is before fromDate');
    if (dto.halfDay && toDate.getTime() !== fromDate.getTime()) {
      throw new BadRequestException('A half-day request must start and end on the same date');
    }
    await assertMonthOpen(this.prisma, user.organisationId, fromDate, toDate);

    // Overlap check: a staffer cannot hold two live requests covering the same
    // day. Without this, the same absence can be booked twice and (once both are
    // approved) charged to the balance twice.
    const clash = await this.prisma.leaveRequest.findFirst({
      where: {
        staffId: actor.staffId,
        status: { in: ['pending', 'approved'] },
        fromDate: { lte: toDate },
        toDate: { gte: fromDate },
      },
    });
    if (clash) {
      throw new BadRequestException(
        `Overlaps an existing ${clash.status} ${clash.type} request (${dateOnly(
          clash.fromDate,
        )} → ${dateOnly(clash.toDate)})`,
      );
    }

    const halfDay = dto.halfDay ?? false;
    const days =
      dto.days != null
        ? dto.days
        : await this.computeWorkingDays(actor.storeId, fromDate, toDate, halfDay);
    if (days <= 0) {
      throw new BadRequestException(
        'That range contains no working days (weekly off / holidays only)',
      );
    }

    // Validate/seed against the request's financial year (Apr–Mar), not calendar year.
    const year = financialYear(fromDate);
    if (PAID_LEAVE_TYPES.includes(dto.type)) {
      await this.ensureLeaveBalances(actor.staffId, year, actor.storeId);
      const [bal, pending] = await Promise.all([
        this.prisma.leaveBalance.findUnique({
          where: { userId_type_year: { userId: actor.staffId, type: dto.type, year } },
        }),
        this.prisma.leaveRequest.aggregate({
          where: { staffId: actor.staffId, type: dto.type, status: 'pending' },
          _sum: { days: true },
        }),
      ]);
      const reserved = num(pending._sum.days);
      const available = num(bal?.allocated) - num(bal?.used) - reserved;
      if (available < days) {
        throw new BadRequestException(
          `Insufficient ${dto.type} balance: ${available} day(s) available${
            reserved > 0 ? ` (${reserved} already awaiting approval)` : ''
          }, ${days} requested`,
        );
      }
    }

    const row = await this.prisma.leaveRequest.create({
      data: {
        organisationId: user.organisationId,
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

    // Leave that nobody is told about is leave that sits until the staffer
    // chases it in person.
    await this.notifications.emitToApprovers(
      actor.storeId,
      'store_manager',
      {
        kind: 'leave_request',
        title: `Leave request from ${actor.staffName ?? 'a team member'}`,
        body: `${LEAVE_TYPE_LABEL[dto.type] ?? dto.type} · ${days} day(s), ${dateOnly(
          fromDate,
        )} → ${dateOnly(toDate)}${dto.reason ? ` — ${dto.reason}` : ''}`,
        href: '/approvals',
        storeId: actor.storeId,
        entityType: 'LeaveRequest',
        entityId: row.id,
        actorId: user.id,
        actorName: user.name,
        dedupeKey: `leave:${row.id}:raised`,
        metadata: { type: dto.type, days },
      },
      actor.staffId,
    );

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
  // Attendance regularization
  // ==========================================================================

  /**
   * POST /hrms/regularize — request a fix for a missed/wrong punch (current user).
   * Refuses a second live request for the same day and refuses future dates.
   */
  async createRegularization(user: AuthUser, dto: CreateRegularizationDto, headerStore?: string) {
    const storeId = this.resolveStoreId(user, headerStore, user.storeIds);
    this.scope.assertStoreAllowed(user, storeId);
    const store = await this.storeCtx(storeId);

    const date = parseDateOnly(dto.date);
    if (date > businessDate(new Date(), store.tz)) {
      throw new BadRequestException('Cannot regularize a future date');
    }
    if (!dto.requestedCheckIn && !dto.requestedCheckOut) {
      throw new BadRequestException('Provide a check-in time, a check-out time, or both');
    }
    await assertMonthOpen(this.prisma, user.organisationId, date);

    const pending = await this.prisma.attendanceRegularization.findFirst({
      where: { storeId, staffId: user.id, date, status: 'pending' },
    });
    if (pending) {
      throw new BadRequestException(
        'You already have a regularization awaiting approval for that date',
      );
    }

    const requestedCheckIn = dto.requestedCheckIn ? new Date(dto.requestedCheckIn) : null;
    const requestedCheckOut = dto.requestedCheckOut ? new Date(dto.requestedCheckOut) : null;
    if (requestedCheckIn && requestedCheckOut && requestedCheckOut <= requestedCheckIn) {
      throw new BadRequestException('Requested check-out must be after the check-in');
    }

    const row = await this.prisma.attendanceRegularization.create({
      data: {
        organisationId: user.organisationId,
        storeId,
        staffId: user.id,
        staffName: user.name,
        date,
        requestedCheckIn,
        requestedCheckOut,
        reason: dto.reason ?? null,
        status: 'pending',
      },
    });

    await this.notifications.emitToApprovers(
      storeId,
      'store_manager',
      {
        kind: 'regularization_request',
        title: `Attendance fix requested by ${user.name}`,
        body: `${dateOnly(date)}${dto.reason ? ` — ${dto.reason}` : ''}`,
        href: '/hrms',
        storeId,
        entityType: 'AttendanceRegularization',
        entityId: row.id,
        actorId: user.id,
        actorName: user.name,
        dedupeKey: `regularization:${row.id}:raised`,
      },
      user.id,
    );

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
   * PATCH /hrms/regularize/:id — approve/reject (manager+). On approval the
   * requested punch(es) are applied to that day's AttendanceRecord and worked
   * minutes, lateness, overtime and the payroll day credit are recomputed.
   *
   * Previously this had none of the controls the leave flow had: it could be
   * approved repeatedly (re-applying the punch each time), a manager could
   * approve their own request, the decision left no attribution and no audit
   * entry, and approval force-set the day to `present` — silently overwriting an
   * approved leave or a declared holiday.
   */
  async decideRegularization(user: AuthUser, id: string, status: LeaveStatus, note?: string) {
    if (status !== 'approved' && status !== 'rejected') {
      throw new BadRequestException('A decision must be either approved or rejected');
    }

    const existing = await this.prisma.attendanceRegularization.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
    });
    if (!existing) throw new NotFoundException('Regularization not found');

    assertUndecided(existing.status, LEAVE_TERMINAL, 'regularization');
    assertNotSelfApproval(user, existing.staffId, 'regularization request');

    let row;
    if (status === 'approved') {
      const { storeId, staffId, staffName, date } = existing;
      await assertMonthOpen(this.prisma, user.organisationId, date);
      const store = await this.storeCtx(storeId);
      const current = await this.prisma.attendanceRecord.findUnique({
        where: { storeId_staffId_date: { storeId, staffId, date } },
      });
      const checkInAt = existing.requestedCheckIn ?? current?.checkInAt ?? null;
      const checkOutAt = existing.requestedCheckOut ?? current?.checkOutAt ?? null;

      const workedMins =
        checkInAt && checkOutAt
          ? Math.round((checkOutAt.getTime() - checkInAt.getTime()) / 60000)
          : (current?.workedMins ?? null);

      // Reuse the historical inputs when present. Regularizing a punch does not
      // authorize silently adopting a later edit to the Shift master.
      const frozenShift = shiftFromSnapshot(current?.shiftSnapshot);
      const liveShift = frozenShift
        ? null
        : await resolveShiftFor(
            this.prisma,
            storeId,
            staffId,
            date,
            current?.shiftId ?? null,
          ).catch(() => null);
      const shift = frozenShift ?? liveShift;

      let isLate = current?.isLate ?? false;
      let lateMinutes = current?.lateMinutes ?? null;
      if (checkInAt && shift) {
        const late = shiftLateness(checkInAt, shift, store.tz);
        isLate = late.isLate;
        lateMinutes = late.lateMinutes;
      }
      const { dayFraction, overtimeMins } = shiftDayMaths(workedMins, shift);

      // Preserve a non-working classification. A regularized punch on a declared
      // holiday or an approved leave day should not quietly reclassify the day.
      const keepStatus =
        current && NON_WORKING_STATUSES.includes(current.status) ? current.status : null;
      const nextStatus: AttendanceStatus =
        keepStatus ??
        (dayFraction != null && dayFraction < 1 ? 'half_day' : isLate ? 'late' : 'present');

      await this.prisma.$transaction(async (tx) => {
        await tx.attendanceRecord.upsert({
          where: { storeId_staffId_date: { storeId, staffId, date } },
          update: {
            checkInAt,
            checkOutAt,
            workedMins,
            isLate,
            lateMinutes,
            shiftId: current?.shiftId ?? liveShift?.id ?? null,
            earlyOutMinutes: checkOutAt ? shiftEarlyOut(checkOutAt, shift, store.tz) : null,
            overtimeMins,
            dayFraction,
            status: nextStatus,
            source: 'regularization',
            // The punch is now human-attested, so it is no longer an auto-close.
            autoClosed: false,
            calculationVersion:
              current?.calculationVersion ?? ATTENDANCE_CALCULATION_VERSION,
            shiftSnapshot: snapshotShift(shift),
          },
          create: {
            organisationId: user.organisationId,
            storeId,
            staffId,
            staffName,
            date,
            status: nextStatus,
            checkInAt,
            checkOutAt,
            workedMins,
            isLate,
            lateMinutes,
            shiftId: liveShift?.id ?? null,
            earlyOutMinutes: checkOutAt ? shiftEarlyOut(checkOutAt, shift, store.tz) : null,
            overtimeMins,
            dayFraction,
            source: 'regularization',
            calculationVersion: ATTENDANCE_CALCULATION_VERSION,
            shiftSnapshot: snapshotShift(liveShift),
          },
        });
        // The ledger: each requested time replaces that side's punches for the day.
        const kinds = [
          existing.requestedCheckIn ? ('in' as const) : null,
          existing.requestedCheckOut ? ('out' as const) : null,
        ].filter((k): k is 'in' | 'out' => k !== null);
        await supersedePunches(tx, {
          userId: staffId,
          storeId,
          date,
          tz: store.tz,
          kinds,
          actorId: user.id,
        });
        for (const kind of kinds) {
          await recordPunch(tx, {
            organisationId: user.organisationId,
            userId: staffId,
            storeId,
            kind,
            eventAt: (kind === 'in' ? existing.requestedCheckIn : existing.requestedCheckOut)!,
            source: 'regularization',
            idempotencyKey: `regularization:${existing.id}:${kind}`,
            note: existing.reason ?? null,
            createdById: user.id,
          });
        }
        const claimed = await tx.attendanceRegularization.updateMany({
          where: { id, status: 'pending' },
          data: { status, ...decisionStamp(user, note) },
        });
        if (claimed.count !== 1) {
          throw new ConflictException('This regularization has already been decided.');
        }
      });
      // Same as a manager's mark: an issued slip is flagged, never rewritten.
      await this.payroll.recheckIssued(staffId, date);
      row = await this.prisma.attendanceRegularization.findUniqueOrThrow({ where: { id } });
    } else {
      const claimed = await this.prisma.attendanceRegularization.updateMany({
        where: { id, status: 'pending' },
        data: { status, ...decisionStamp(user, note) },
      });
      if (claimed.count !== 1) {
        throw new ConflictException('This regularization has already been decided.');
      }
      row = await this.prisma.attendanceRegularization.findUniqueOrThrow({ where: { id } });
    }

    await this.audit.record(user, {
      action: status === 'approved' ? 'regularization.approve' : 'regularization.reject',
      entityType: 'AttendanceRegularization',
      entityId: row.id,
      storeId: row.storeId,
      summary: `${status === 'approved' ? 'Approved' : 'Rejected'} attendance regularization for ${
        row.staffName ?? row.staffId
      } on ${dateOnly(row.date)}`,
      metadata: {
        from: existing.status,
        to: status,
        requestedCheckIn: existing.requestedCheckIn,
        requestedCheckOut: existing.requestedCheckOut,
        note: note ?? null,
      },
    });

    await this.notifications.emit([row.staffId], {
      kind: 'regularization_request',
      title: `Attendance fix for ${dateOnly(row.date)} was ${status}`,
      body: `${status} by ${user.name}${note?.trim() ? `: ${note.trim()}` : ''}`,
      href: '/hrms',
      storeId: row.storeId,
      entityType: 'AttendanceRegularization',
      entityId: row.id,
      priority: status === 'rejected' ? 'high' : 'normal',
      actorId: user.id,
      actorName: user.name,
      dedupeKey: `regularization:${row.id}:decided`,
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
      date: dateOnly(r.date),
      requestedCheckIn: r.requestedCheckIn,
      requestedCheckOut: r.requestedCheckOut,
      reason: r.reason ?? null,
      status: r.status,
      decidedBy: r.decidedByName ?? null,
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
      decisionNote: r.decisionNote ?? null,
    };
  }

  // ==========================================================================
  // Leaderboard / commission
  // ==========================================================================

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
          ...(isFrontLine(user.role) ? { id: user.id } : {}),
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
          role: ROLE_LABELS[u.role],
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

  /** GET /hrms/commission — incentive rows from Commission table. */
  async commission(user: AuthUser, headerStore?: string) {
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    if (storeIds.length === 0) return [];

    const commissions = await this.prisma.commission.findMany({
      where: {
        storeId: { in: storeIds },
        // OP-5: a salesperson only ever sees their own incentive numbers.
        ...(isFrontLine(user.role) ? { userId: user.id } : {}),
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
      role: ROLE_LABELS[c.user.role as Role] ?? '—',
      storeId: c.storeId ?? c.user.userStores?.[0]?.storeId ?? '',
      salesValue: num(c.salesValue),
      rate: num(c.rate) / 100,
      incentive: num(c.amount),
      target: Math.round(num(c.salesValue) * 0.85),
    };
  }

  /**
   * PATCH /hrms/commission/:id — set the rate and recompute the incentive amount
   * (amount = salesValue × rate / 100).
   */
  async updateCommissionRate(user: AuthUser, id: string, rate: number) {
    // Head office is view-only for sales-performance data. The role-rank guard
    // rolls up (store_manager admits everything higher), so HO must be blocked
    // here explicitly — a rank floor alone can't carve out the top role.
    if (user.role === 'head_office') {
      throw new ForbiddenException(
        'Head office is view-only for sales-performance data',
      );
    }

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

    // Nobody sets their own incentive rate.
    assertNotSelfApproval(user, existing.userId, 'commission rate');

    const fromRate = num(existing.rate);
    const amount = new Prisma.Decimal(existing.salesValue).mul(rate).div(100);
    const row = await this.prisma.commission.update({
      where: { id },
      data: { rate, amount },
      include: { user: { include: { userStores: true } } },
    });

    await this.audit.record(user, {
      action: 'commission.rate_change',
      entityType: 'Commission',
      entityId: row.id,
      storeId: row.storeId ?? existing.user.userStores[0]?.storeId ?? null,
      summary: `Changed ${existing.user.name} commission rate for ${existing.period}: ${fromRate}% → ${rate}%`,
      metadata: { from: fromRate, to: rate },
    });

    return this.toCommissionView(row);
  }

  // ==========================================================================
  // Register + corrections (docs/modules/06-attendance.md)
  // ==========================================================================

  /**
   * GET /hrms/attendance/register — the daily register over a date range,
   * paginated. Default: the last 31 days at the selected store.
   */
  async register(user: AuthUser, q: RegisterQueryDto, headerStore?: string) {
    const storeSel = q.storeId ?? headerStore;
    const tz = await this.scope.resolveTimezone(user, storeSel);
    const to = q.to ? parseDateOnly(q.to) : businessDate(new Date(), tz);
    const from = q.from ? parseDateOnly(q.from) : addDays(to, -30);
    if (to < from) throw new BadRequestException('`to` must be on or after `from`');
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;

    const where: Prisma.AttendanceRecordWhereInput = {
      ...this.scope.storeFilter(user, storeSel),
      date: { gte: from, lte: to },
      ...(q.userId ? { staffId: q.userId } : {}),
      ...(q.status === 'late'
        ? { OR: [{ status: 'late' }, { status: 'present', isLate: true }] }
        : q.status
          ? { status: q.status }
          : {}),
    };
    if (isFrontLine(user.role)) where.staffId = user.id;

    const [total, rows] = await Promise.all([
      this.prisma.attendanceRecord.count({ where }),
      this.prisma.attendanceRecord.findMany({
        where,
        include: { store: true },
        orderBy: [{ date: 'desc' }, { staffName: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: await this.toRegisterRows(rows), total, page, pageSize };
  }

  private async toRegisterRows(rows: any[]) {
    const [shifts, staff] = await Promise.all([
      this.prisma.shift.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.shiftId).filter(Boolean))] as string[] } },
      }),
      this.prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.staffId))] as string[] } },
        select: { id: true, role: true, employeeProfile: { select: { employeeCode: true } } },
      }),
    ]);
    const shiftById = new Map(shifts.map((s) => [s.id, s]));
    const roleById = new Map(staff.map((s) => [s.id, s.role]));
    const codeById = new Map(staff.map((s) => [s.id, s.employeeProfile?.employeeCode ?? null]));
    return rows.map((r) => ({
      ...this.toAttendanceView(r, shiftById, roleById),
      recordId: r.id,
      source: r.source ?? 'self',
      employeeCode: codeById.get(r.staffId) ?? null,
    }));
  }

  private async registerRow(id: string) {
    const row = await this.prisma.attendanceRecord.findUniqueOrThrow({ where: { id }, include: { store: true } });
    return (await this.toRegisterRows([row]))[0];
  }

  private async recordInScope(user: AuthUser, id: string) {
    const row = await this.prisma.attendanceRecord.findFirst({
      where: { id, organisationId: user.organisationId, ...this.scope.storeFilter(user) },
    });
    if (!row) throw new NotFoundException('Attendance record not found');
    await assertCanCorrectUser(this.prisma, user, row.staffId);
    return row;
  }

  /**
   * PATCH /hrms/attendance/:id — a manager's (or head office's) correction.
   *
   * Times are store-local "HH:MM" on the record's date (a check-out earlier
   * than the check-in is the next morning). Each changed time supersedes that
   * side's punches in the ledger with a `manager` punch, and the row is then
   * recomputed by the same code a processing run uses — so a later run gives
   * the same answer. A non-attended status (absent / leave / off / holiday)
   * voids the day's punches instead.
   */
  async updateAttendance(user: AuthUser, id: string, dto: UpdateAttendanceDto) {
    const before = await this.recordInScope(user, id);
    await assertMonthOpen(this.prisma, user.organisationId, before.date);
    const store = await this.storeCtx(before.storeId);
    const note = dto.note.trim();
    const nonAttended = !!dto.status && !['present', 'late', 'half_day'].includes(dto.status);
    if (nonAttended && (dto.checkIn || dto.checkOut)) {
      throw new BadRequestException(`A day marked ${dto.status} has no punch times`);
    }
    if (!dto.status && !dto.checkIn && !dto.checkOut && !dto.shiftId) {
      throw new BadRequestException('Nothing to change');
    }
    const correctionShift = dto.shiftId
      ? await resolveShiftFor(this.prisma, before.storeId, null, null, dto.shiftId)
      : null;

    const dayArgs = {
      userId: before.staffId,
      storeId: before.storeId,
      date: before.date,
      tz: store.tz,
      actorId: user.id,
    };
    await this.prisma.$transaction(async (tx) => {
      if (nonAttended) {
        await supersedePunches(tx, { ...dayArgs, kinds: ['in', 'out'] });
        await tx.attendanceRecord.update({
          where: { id },
          data: {
            status: dto.status,
            checkInAt: null,
            checkOutAt: null,
            isLate: false,
            lateMinutes: null,
            workedMins: null,
            earlyOutMinutes: null,
            overtimeMins: null,
            dayFraction: dto.status === 'absent' ? 0 : null,
            shiftId: dto.shiftId ?? before.shiftId,
            calculationVersion: ATTENDANCE_CALCULATION_VERSION,
            shiftSnapshot: snapshotShift(
              correctionShift ?? shiftFromSnapshot(before.shiftSnapshot),
            ),
            source: 'manager',
            autoClosed: false,
          },
        });
        return;
      }

      const inMins = dto.checkIn
        ? parseHHMM(dto.checkIn)
        : before.checkInAt
          ? parseHHMM(formatHHMMInTz(before.checkInAt, store.tz)!)
          : null;
      const inAt = dto.checkIn ? instantFromLocalTime(before.date, inMins!, store.tz) : null;
      let outAt: Date | null = null;
      if (dto.checkOut) {
        const outMins = parseHHMM(dto.checkOut);
        outAt = instantFromLocalTime(
          before.date,
          outMins + (inMins != null && outMins <= inMins ? 1440 : 0),
          store.tz,
        );
      }
      if (!inAt && !before.checkInAt && !outAt) {
        throw new BadRequestException('Give a check-in time to mark this day attended');
      }
      if (outAt && outAt.getTime() > Date.now() + 5 * 60_000) {
        throw new BadRequestException('A check-out cannot be in the future');
      }
      // Evidence first: a pre-ledger row's own times reach the ledger before
      // anything supersedes them.
      await seedLedgerFromRow(tx, user.organisationId, before, store.tz);
      for (const [kind, at] of [
        ['in', inAt],
        ['out', outAt],
      ] as const) {
        if (!at) continue;
        await supersedePunches(tx, { ...dayArgs, kinds: [kind] });
        await recordPunch(tx, {
          organisationId: user.organisationId,
          userId: before.staffId,
          storeId: before.storeId,
          kind,
          eventAt: at,
          source: 'manager',
          idempotencyKey: `manager:${id}:${kind}:${at.toISOString()}`,
          note,
          createdById: user.id,
        });
      }
      const current = await tx.attendanceRecord.update({
        where: { id },
        data: {
          shiftId: dto.shiftId ?? before.shiftId,
          calculationVersion: ATTENDANCE_CALCULATION_VERSION,
          shiftSnapshot: snapshotShift(
            correctionShift ?? shiftFromSnapshot(before.shiftSnapshot),
          ),
          source: 'manager',
          autoClosed: false,
        },
      });
      await this.ops.reprocessDay({
        orgId: user.organisationId,
        store: { id: store.id, tz: store.tz },
        userId: before.staffId,
        staffName: before.staffName,
        date: before.date,
        facts: { onLeave: false, isHoliday: false, isWeekOff: false },
        existing: current,
        prisma: tx,
      });
    });

    const after = await this.prisma.attendanceRecord.findUniqueOrThrow({ where: { id } });
    await this.audit.record(user, {
      action: 'attendance.update',
      entityType: 'AttendanceRecord',
      entityId: id,
      storeId: before.storeId,
      summary: `Corrected ${before.staffName ?? before.staffId}'s attendance on ${dateOnly(before.date)}: ${note}`,
      metadata: { before, after, note },
    });
    await this.payroll.recheckIssued(before.staffId, before.date);
    return this.registerRow(id);
  }

  /** DELETE /hrms/attendance/:id — removes the register row; the raw punches stay. */
  async deleteAttendance(user: AuthUser, id: string, reason: string) {
    const before = await this.recordInScope(user, id);
    await assertMonthOpen(this.prisma, user.organisationId, before.date);
    const store = await this.storeCtx(before.storeId);
    await this.prisma.$transaction(async (tx) => {
      // Keeping live punches while deleting only the derived row made the next
      // processing run resurrect the attendance. Preserve evidence, but void it
      // with attribution so deletion has durable meaning.
      await supersedePunches(tx, {
        userId: before.staffId,
        storeId: before.storeId,
        date: before.date,
        tz: store.tz,
        kinds: ['in', 'out'],
        actorId: user.id,
      });
      await tx.attendanceRecord.delete({ where: { id } });
    });
    await this.audit.record(user, {
      action: 'attendance.delete',
      entityType: 'AttendanceRecord',
      entityId: id,
      storeId: before.storeId,
      summary: `Deleted ${before.staffName ?? before.staffId}'s attendance row for ${dateOnly(before.date)}: ${reason.trim()}`,
      metadata: { before, after: null, reason },
    });
    await this.payroll.recheckIssued(before.staffId, before.date);
    return { id, deleted: true };
  }

  // ==========================================================================
  // Leave — manager edit / delete, balance maintenance
  // ==========================================================================

  private async leaveInScope(user: AuthUser, id: string) {
    const row = await this.prisma.leaveRequest.findFirst({ where: { id, ...this.scope.storeFilter(user) } });
    if (!row) throw new NotFoundException('Leave request not found');
    await assertCanCorrectUser(this.prisma, user, row.staffId);
    return row;
  }

  /** PATCH /hrms/leave/:id/edit — a manager corrects a PENDING request. */
  async editLeave(user: AuthUser, id: string, dto: EditLeaveDto) {
    const before = await this.leaveInScope(user, id);
    if (before.status !== 'pending') {
      throw new BadRequestException(`Only a pending request can be edited (this one is ${before.status})`);
    }
    const fromDate = parseDateOnly(dto.fromDate);
    const toDate = parseDateOnly(dto.toDate);
    const halfDay = dto.halfDay ?? false;
    if (toDate < fromDate) throw new BadRequestException('toDate is before fromDate');
    if (halfDay && toDate.getTime() !== fromDate.getTime()) {
      throw new BadRequestException('A half-day request must start and end on the same date');
    }
    await assertMonthOpen(this.prisma, user.organisationId, before.fromDate, before.toDate);
    await assertMonthOpen(this.prisma, user.organisationId, fromDate, toDate);

    const clash = await this.prisma.leaveRequest.findFirst({
      where: {
        id: { not: id },
        staffId: before.staffId,
        status: { in: ['pending', 'approved'] },
        fromDate: { lte: toDate },
        toDate: { gte: fromDate },
      },
    });
    if (clash) {
      throw new BadRequestException(
        `Overlaps an existing ${clash.status} ${clash.type} request (${dateOnly(clash.fromDate)} → ${dateOnly(clash.toDate)})`,
      );
    }
    const days = await this.computeWorkingDays(before.storeId, fromDate, toDate, halfDay);
    if (days <= 0) {
      throw new BadRequestException('That range contains no working days (weekly off / holidays only)');
    }

    if (PAID_LEAVE_TYPES.includes(dto.type)) {
      const year = financialYear(fromDate);
      await this.ensureLeaveBalances(before.staffId, year, before.storeId);
      const [bal, pending] = await Promise.all([
        this.prisma.leaveBalance.findUnique({
          where: { userId_type_year: { userId: before.staffId, type: dto.type, year } },
        }),
        this.prisma.leaveRequest.aggregate({
          where: { staffId: before.staffId, type: dto.type, status: 'pending', id: { not: id } },
          _sum: { days: true },
        }),
      ]);
      const available = num(bal?.allocated) - num(bal?.used) - num(pending._sum.days);
      if (available < days) {
        throw new BadRequestException(
          `Insufficient ${dto.type} balance: ${available} day(s) available, ${days} requested`,
        );
      }
    }

    const row = await this.prisma.leaveRequest.update({
      where: { id },
      data: { fromDate, toDate, type: dto.type, halfDay, days, reason: dto.reason ?? before.reason },
    });
    await this.audit.record(user, {
      action: 'leave.edit',
      entityType: 'LeaveRequest',
      entityId: id,
      storeId: row.storeId,
      summary: `Edited ${row.staffName ?? row.staffId}'s pending leave: ${dateOnly(fromDate)} → ${dateOnly(toDate)} (${days} day(s))`,
      metadata: { before: this.toLeaveView(before), after: this.toLeaveView(row) },
    });
    return this.toLeaveView(row);
  }

  /** DELETE /hrms/leave/:id — removes a request; an approved one gives its days back. */
  async deleteLeave(user: AuthUser, id: string, reason: string) {
    const before = await this.leaveInScope(user, id);
    await assertMonthOpen(this.prisma, user.organisationId, before.fromDate, before.toDate);
    const days = num(before.days);
    const release = before.status === 'approved' && PAID_LEAVE_TYPES.includes(before.type) && days > 0;
    const year = financialYear(before.fromDate);
    await this.prisma.$transaction(async (tx) => {
      if (release) {
        await tx.leaveBalance.updateMany({
          where: { userId: before.staffId, type: before.type, year },
          data: { used: { decrement: days } },
        });
      }
      await tx.leaveRequest.delete({ where: { id } });
    });
    await this.audit.record(user, {
      action: 'leave.delete',
      entityType: 'LeaveRequest',
      entityId: id,
      storeId: before.storeId,
      summary: `Deleted ${before.status} ${before.type} leave for ${before.staffName ?? before.staffId}: ${reason.trim()}`,
      metadata: { before: this.toLeaveView(before), after: null, balanceReleased: release, reason },
    });
    return { id, deleted: true, balanceReleased: release };
  }

  private async balanceOwnerInScope(user: AuthUser, userId: string) {
    const owner = await this.prisma.user.findFirst({
      where: { id: userId, organisationId: user.organisationId },
      include: { userStores: true },
    });
    if (!owner || !owner.userStores.some((s) => user.storeIds.includes(s.storeId))) {
      throw new NotFoundException('Staff not found');
    }
    return owner;
  }

  /** PATCH /hrms/leave/balances/:id — head office adjusts allocation / used, with a note. */
  async updateLeaveBalance(user: AuthUser, id: string, dto: UpdateLeaveBalanceDto) {
    const before = await this.prisma.leaveBalance.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Leave balance not found');
    const owner = await this.balanceOwnerInScope(user, before.userId);
    if (dto.allocated == null && dto.used == null) throw new BadRequestException('Nothing to change');
    const row = await this.prisma.leaveBalance.update({
      where: { id },
      data: { allocated: dto.allocated, used: dto.used },
    });
    await this.audit.record(user, {
      action: 'leave.balance_update',
      entityType: 'LeaveBalance',
      entityId: id,
      storeId: before.storeId,
      summary: `Adjusted ${owner.name}'s ${before.type} balance for ${financialYearLabel(before.year)}: ${dto.note.trim()}`,
      metadata: {
        before: { allocated: num(before.allocated), used: num(before.used) },
        after: { allocated: num(row.allocated), used: num(row.used) },
        note: dto.note,
      },
    });
    return this.toBalanceView(row);
  }

  /** POST /hrms/leave/balances — head office grants a type/year row (e.g. week-off leave). */
  async createLeaveBalance(user: AuthUser, dto: CreateLeaveBalanceDto) {
    const owner = await this.balanceOwnerInScope(user, dto.userId);
    const exists = await this.prisma.leaveBalance.findUnique({
      where: { userId_type_year: { userId: dto.userId, type: dto.type, year: dto.year } },
    });
    if (exists) throw new ConflictException('That balance already exists — edit it instead');
    const row = await this.prisma.leaveBalance.create({
      data: {
        userId: dto.userId,
        storeId: owner.userStores.find((s) => s.isPrimary)?.storeId ?? owner.userStores[0]?.storeId ?? null,
        type: dto.type,
        year: dto.year,
        allocated: dto.allocated,
      },
    });
    await this.audit.record(user, {
      action: 'leave.balance_create',
      entityType: 'LeaveBalance',
      entityId: row.id,
      storeId: row.storeId,
      summary: `Granted ${owner.name} ${dto.allocated} ${dto.type} day(s) for ${financialYearLabel(dto.year)}`,
      metadata: { before: null, after: { type: dto.type, year: dto.year, allocated: dto.allocated } },
    });
    return this.toBalanceView(row);
  }

  private toBalanceView(r: { id: string; userId: string; type: LeaveType; year: number; allocated: Prisma.Decimal; used: Prisma.Decimal }) {
    return {
      id: r.id,
      userId: r.userId,
      type: r.type,
      label: LEAVE_TYPE_LABEL[r.type] ?? r.type,
      year: r.year,
      financialYearLabel: financialYearLabel(r.year),
      allocated: num(r.allocated),
      used: num(r.used),
      balance: num(r.allocated) - num(r.used),
    };
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
      // The action's store must be one the TARGET is actually assigned to AND that
      // the caller may see. Never trust a header store the target isn't in — else a
      // manager could act on any user by passing a store they happen to control.
      const targetStores = target.userStores.map((s) => s.storeId);
      const inScope = targetStores.filter(
        (s) => user.allStores || user.storeIds.includes(s),
      );
      if (inScope.length === 0) {
        throw new ForbiddenException('Staff is not in your store scope');
      }
      let storeId: string;
      if (headerStore && headerStore !== 'all') {
        if (!inScope.includes(headerStore)) {
          throw new ForbiddenException('Staff is not assigned to the selected store');
        }
        storeId = headerStore;
      } else {
        storeId = inScope[0];
      }
      return { staffId: target.id, staffName: target.name, storeId };
    }
    const storeId = this.resolveStoreId(user, headerStore, user.storeIds);
    this.scope.assertStoreAllowed(user, storeId);
    return { staffId: user.id, staffName: user.name, storeId };
  }
}
