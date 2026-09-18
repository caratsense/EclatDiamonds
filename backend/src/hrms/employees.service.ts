import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AttendanceStatus, LeaveType, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { StoreScopeService } from '../common/store-scope.service';
import { ROLE_RANK } from '../common/role.util';
import {
  DEFAULT_TZ,
  businessDate,
  dateOnly,
  formatHHMMInTz,
  instantFromLocalTime,
  resolveTz,
} from '../common/tz.util';
import { allocateLoginId, readSignupPolicy, renderLoginId, withSavepoint } from '../users/users.util';
import {
  BulkEmployeesDto,
  CreateEmployeeDto,
  DepartmentDto,
  DesignationDto,
  EmployeeProfileFieldsDto,
  EmployeeQueryDto,
  SeparateEmployeeDto,
  UpdateDepartmentDto,
  UpdateDesignationDto,
  UpdateEmployeeDto,
} from './dto/employees.dto';
import {
  DEFAULT_SHIFTS,
  LEAVE_TYPE_MAP,
  emailIssue,
  last10,
  normKey,
  parseClock,
  parseCsv,
  parseDmy,
  titleCase,
} from './ezattendance-import';
import {
  ATTENDANCE_CALCULATION_VERSION,
  snapshotShift,
  type ShiftLike,
} from './attendance-ops.service';

type Tx = Prisma.TransactionClient;
type Db = PrismaService | Tx;
type Upload = { buffer?: Buffer; originalname?: string } | undefined;

const EMPLOYEE_INCLUDE = {
  userStores: {
    include: { store: { select: { id: true, name: true } } },
    orderBy: { isPrimary: 'desc' as const },
  },
  employeeProfile: {
    include: {
      department: { select: { id: true, name: true } },
      designation: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.UserInclude;

type EmployeeUser = Prisma.UserGetPayload<{ include: typeof EMPLOYEE_INCLUDE }>;

/** Profile columns a PATCH/POST may set (besides the relations validated separately). */
const TEXT_FIELDS = [
  'biometricNo',
  'unit',
  'gender',
  'employmentType',
  'bloodGroup',
  'address',
  'personalEmail',
  'shiftCode',
] as const;
const DATE_FIELDS = ['dateOfBirth', 'dateOfJoining', 'dateOfConfirmation'] as const;

/** Fields the importer owns on a profile, in diff order. */
const IMPORT_FIELDS = [
  'biometricNo',
  'departmentId',
  'designationId',
  'unit',
  'gender',
  'dateOfBirth',
  'dateOfJoining',
  'dateOfConfirmation',
  'bloodGroup',
  'address',
  'personalEmail',
  'shiftCode',
  'source',
  'sourceRaw',
] as const;

const PROTECTED_SOURCES = ['self', 'manager', 'regularization'];

const ymd = (s: string) => new Date(`${s}T00:00:00.000Z`);
/** Key-order independent JSON (Postgres JSONB reorders object keys). */
const stable = (v: unknown): string =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? JSON.stringify(
        Object.keys(v)
          .sort()
          .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
      )
    : JSON.stringify(v ?? null);
const same = (a: unknown, b: unknown) =>
  a instanceof Date || b instanceof Date
    ? (a instanceof Date ? dateOnly(a) : (a ?? null)) === (b instanceof Date ? dateOnly(b) : (b ?? null))
    : stable(a) === stable(b);

/** Personal columns never written to audit metadata (store managers can read their store's trail). */
const PERSONAL_FIELDS = ['dateOfBirth', 'bloodGroup', 'address'] as const;
export function redactPersonal<T extends Record<string, unknown> | null>(obj: T): T {
  if (!obj) return obj;
  const out: Record<string, unknown> = { ...obj };
  for (const f of PERSONAL_FIELDS) if (out[f] != null) out[f] = '[redacted]';
  return out as T;
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || name.slice(0, 2).toUpperCase()
  );
}

/** Thrown to roll a dry-run transaction back while carrying its result out. */
class DryRun extends Error {
  constructor(readonly result: unknown) {
    super('dry run');
  }
}

/** Employee master, departments, designations and the EzAttendance import. See docs/modules/06-attendance.md. */
@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
  ) {}

  // ==========================================================================
  // Departments + designations (organisation-level masters)
  // ==========================================================================

  async listDepartments(user: AuthUser) {
    const rows = await this.prisma.department.findMany({
      where: { organisationId: user.organisationId },
      include: { _count: { select: { employees: true } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    const stores = await this.storeNames(user.organisationId);
    return rows.map(({ _count, ...d }) => ({
      ...d,
      storeName: d.storeId ? (stores.get(d.storeId) ?? null) : null,
      employeeCount: _count.employees,
    }));
  }

  async createDepartment(user: AuthUser, dto: DepartmentDto) {
    if (dto.storeId) await this.assertOrgStore(user, dto.storeId);
    const row = await this.uniqueName(() =>
      this.prisma.department.create({
        data: {
          organisationId: user.organisationId,
          name: dto.name,
          storeId: dto.storeId ?? null,
          sortOrder: dto.sortOrder ?? 0,
          isActive: dto.isActive ?? true,
        },
      }),
    );
    await this.auditMaster(user, 'department.create', 'Department', row.id, null, row);
    return row;
  }

  async updateDepartment(user: AuthUser, id: string, dto: UpdateDepartmentDto) {
    const before = await this.prisma.department.findFirst({
      where: { id, organisationId: user.organisationId },
    });
    if (!before) throw new NotFoundException('Department not found');
    if (dto.storeId) await this.assertOrgStore(user, dto.storeId);
    const row = await this.uniqueName(() =>
      this.prisma.department.update({
        where: { id },
        data: {
          name: dto.name,
          storeId: dto.storeId === undefined ? undefined : dto.storeId || null,
          sortOrder: dto.sortOrder,
          isActive: dto.isActive,
        },
      }),
    );
    await this.auditMaster(user, 'department.update', 'Department', id, before, row);
    return row;
  }

  async deleteDepartment(user: AuthUser, id: string, reassignTo?: string) {
    const before = await this.prisma.department.findFirst({
      where: { id, organisationId: user.organisationId },
    });
    if (!before) throw new NotFoundException('Department not found');
    const inUse = await this.prisma.employeeProfile.count({
      where: { departmentId: id },
    });
    if (inUse && !reassignTo) {
      throw new ConflictException(
        `${inUse} employee(s) are in ${before.name}. Move them to another department first.`,
      );
    }
    if (reassignTo) {
      const target = await this.prisma.department.findFirst({
        where: { id: reassignTo, organisationId: user.organisationId },
      });
      if (!target || target.id === id)
        throw new BadRequestException('Choose another department to move them to');
    }
    await this.prisma.$transaction([
      this.prisma.employeeProfile.updateMany({
        where: { departmentId: id },
        data: { departmentId: reassignTo ?? null },
      }),
      this.prisma.department.delete({ where: { id } }),
    ]);
    await this.auditMaster(user, 'department.delete', 'Department', id, before, {
      reassignTo: reassignTo ?? null,
      moved: inUse,
    });
    return { deleted: true, moved: inUse };
  }

  async listDesignations(user: AuthUser) {
    const rows = await this.prisma.designation.findMany({
      where: { organisationId: user.organisationId },
      include: { _count: { select: { employees: true } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map(({ _count, ...d }) => ({
      ...d,
      employeeCount: _count.employees,
    }));
  }

  async createDesignation(user: AuthUser, dto: DesignationDto) {
    const row = await this.uniqueName(() =>
      this.prisma.designation.create({
        data: {
          organisationId: user.organisationId,
          name: dto.name,
          sortOrder: dto.sortOrder ?? 0,
          isActive: dto.isActive ?? true,
        },
      }),
    );
    await this.auditMaster(user, 'designation.create', 'Designation', row.id, null, row);
    return row;
  }

  async updateDesignation(user: AuthUser, id: string, dto: UpdateDesignationDto) {
    const before = await this.prisma.designation.findFirst({
      where: { id, organisationId: user.organisationId },
    });
    if (!before) throw new NotFoundException('Designation not found');
    const row = await this.uniqueName(() =>
      this.prisma.designation.update({
        where: { id },
        data: {
          name: dto.name,
          sortOrder: dto.sortOrder,
          isActive: dto.isActive,
        },
      }),
    );
    await this.auditMaster(user, 'designation.update', 'Designation', id, before, row);
    return row;
  }

  async deleteDesignation(user: AuthUser, id: string, reassignTo?: string) {
    const before = await this.prisma.designation.findFirst({
      where: { id, organisationId: user.organisationId },
    });
    if (!before) throw new NotFoundException('Designation not found');
    const inUse = await this.prisma.employeeProfile.count({
      where: { designationId: id },
    });
    if (inUse && !reassignTo) {
      throw new ConflictException(
        `${inUse} employee(s) are ${before.name}. Move them to another designation first.`,
      );
    }
    if (reassignTo) {
      const target = await this.prisma.designation.findFirst({
        where: { id: reassignTo, organisationId: user.organisationId },
      });
      if (!target || target.id === id)
        throw new BadRequestException('Choose another designation to move them to');
    }
    await this.prisma.$transaction([
      this.prisma.employeeProfile.updateMany({
        where: { designationId: id },
        data: { designationId: reassignTo ?? null },
      }),
      this.prisma.designation.delete({ where: { id } }),
    ]);
    await this.auditMaster(user, 'designation.delete', 'Designation', id, before, {
      reassignTo: reassignTo ?? null,
      moved: inUse,
    });
    return { deleted: true, moved: inUse };
  }

  // ==========================================================================
  // Employees
  // ==========================================================================

  async list(user: AuthUser, query: EmployeeQueryDto) {
    const users = await this.prisma.user.findMany({
      where: this.visibleWhere(user, query.storeId),
      include: EMPLOYEE_INCLUDE,
      orderBy: { name: 'asc' },
    });
    const rows = await this.toRows(user, users);
    const q = query.q?.trim().toLowerCase();
    // ponytail: filtered in memory; staff lists are tens of rows. Push into SQL past a few thousand.
    return rows.filter(
      (r) =>
        (!query.departmentId || r.department?.id === query.departmentId) &&
        (!query.designationId || r.designation?.id === query.designationId) &&
        (!query.status || r.status === query.status) &&
        (!q ||
          [r.name, r.employeeCode, r.phone, r.loginEmail, r.personalEmail].some((v) =>
            v?.toLowerCase().includes(q),
          )),
    );
  }

  async detail(user: AuthUser, userId: string) {
    const target = await this.loadVisible(user, userId);
    const [row] = await this.toRows(user, [target]);
    const [balances, attendance] = await Promise.all([
      this.prisma.leaveBalance.findMany({
        where: { userId },
        orderBy: [{ year: 'desc' }, { type: 'asc' }],
      }),
      this.prisma.attendanceRecord.findMany({
        where: {
          staffId: userId,
          organisationId: user.organisationId,
          storeId: { in: user.storeIds },
        },
        include: { store: { select: { name: true, timezone: true } } },
        orderBy: { date: 'desc' },
        take: 30,
      }),
    ]);
    return {
      ...row,
      leaveBalances: balances.map((b) => ({
        id: b.id,
        type: b.type,
        year: b.year,
        allocated: Number(b.allocated),
        used: Number(b.used),
        remaining: Number(b.allocated) - Number(b.used),
      })),
      recentAttendance: attendance.map((a) => ({
        id: a.id,
        date: dateOnly(a.date),
        storeId: a.storeId,
        storeName: a.store.name,
        status: a.status,
        isLate: a.isLate,
        lateMinutes: a.lateMinutes,
        checkIn: formatHHMMInTz(a.checkInAt, resolveTz(a.store.timezone)),
        checkOut: formatHHMMInTz(a.checkOutAt, resolveTz(a.store.timezone)),
        source: a.source,
      })),
    };
  }

  /** New staff arrive inactive with no password: head office issues the login. */
  async create(user: AuthUser, dto: CreateEmployeeDto) {
    if (dto.role === 'head_office' || ROLE_RANK[dto.role] >= ROLE_RANK[user.role]) {
      throw new ForbiddenException('You can only add people below your own role');
    }
    const storeIds = [...new Set(dto.storeIds)];
    if (!storeIds.length && !user.allStores) throw new BadRequestException('Choose at least one store');
    const stores = await this.assertStores(user, storeIds);
    await this.assertProfileRefs(user, dto);
    await this.assertCodeFree(user.organisationId, dto.employeeCode);

    const org = await this.prisma.organisation.findUniqueOrThrow({
      where: { id: user.organisationId },
      select: { slug: true, settings: true },
    });
    const policy = readSignupPolicy(org.settings);
    const subject = {
      name: dto.name,
      storeName: stores[0]?.name ?? dto.unit ?? 'office',
      organisationSlug: org.slug,
    };

    const created = await this.prisma.$transaction(async (tx) => {
      const u = await allocateLoginId(
        (n) => renderLoginId(policy.loginIdTemplate, subject, n),
        (email) =>
          withSavepoint(tx, () =>
            tx.user.create({
              data: {
                organisationId: user.organisationId,
                name: dto.name,
                email,
                phone: dto.phone?.trim() || null,
                contactEmail: dto.personalEmail?.toLowerCase() || null,
                initials: initialsOf(dto.name),
                role: dto.role,
                isActive: false,
                passwordHash: null,
                userStores: {
                  create: storeIds.map((storeId, i) => ({
                    storeId,
                    isPrimary: i === 0,
                  })),
                },
              },
            }),
          ),
      );
      await tx.employeeProfile.create({
        data: {
          organisationId: user.organisationId,
          userId: u.id,
          employeeCode: dto.employeeCode,
          ...this.profileData(dto),
          status: dto.status,
        },
      });
      return u;
    });

    const row = await this.detail(user, created.id);
    await this.audit.record(user, {
      action: 'employee.create',
      entityType: 'User',
      entityId: created.id,
      storeId: storeIds[0] ?? null,
      summary: `Added employee ${dto.name} (${dto.employeeCode})`,
      metadata: { before: null, after: this.auditView(row) },
    });
    return row;
  }

  async update(user: AuthUser, userId: string, dto: UpdateEmployeeDto) {
    const target = await this.loadVisible(user, userId);
    this.assertCanManage(user, target);
    const isHO = user.role === 'head_office';
    if ((dto.role !== undefined && dto.role !== target.role) || dto.storeIds !== undefined) {
      if (!isHO) throw new ForbiddenException('Only head office can change a role or stores');
    }
    if (dto.role !== undefined && dto.role !== target.role) {
      if (dto.role === 'head_office' || target.role === 'head_office') {
        throw new ForbiddenException('Head office roles are not changed here');
      }
    }
    const storeIds = dto.storeIds ? [...new Set(dto.storeIds)] : undefined;
    if (storeIds) await this.assertStores(user, storeIds);
    await this.assertProfileRefs(user, dto);
    const profile = target.employeeProfile;
    if (dto.status === 'active' && profile?.status === 'separated' && !isHO) {
      throw new ForbiddenException('Only head office can bring back someone who has been separated');
    }
    if (dto.employeeCode && dto.employeeCode !== profile?.employeeCode) {
      await this.assertCodeFree(user.organisationId, dto.employeeCode);
    }
    if (!profile && !dto.employeeCode) {
      throw new BadRequestException('An employee code is needed to start this person’s employee record');
    }
    if (dto.reportingManagerId === userId)
      throw new BadRequestException('Someone cannot report to themselves');

    const before = this.auditView((await this.toRows(user, [target]))[0]);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          name: dto.name,
          initials: dto.name ? initialsOf(dto.name) : undefined,
          phone: dto.phone === undefined ? undefined : dto.phone?.trim() || null,
          role: dto.role,
        },
      });
      if (storeIds) {
        await tx.userStore.deleteMany({
          where: { userId, storeId: { notIn: storeIds } },
        });
        for (const [i, storeId] of storeIds.entries()) {
          await tx.userStore.upsert({
            where: { userId_storeId: { userId, storeId } },
            update: { isPrimary: i === 0 },
            create: { userId, storeId, isPrimary: i === 0 },
          });
        }
      }
      const data = {
        ...this.profileData(dto),
        employeeCode: dto.employeeCode,
        status: dto.status,
        ...(dto.status === 'active' ? { exitDate: null, exitReason: null } : {}),
      };
      await tx.employeeProfile.upsert({
        where: { userId },
        update: data,
        create: {
          ...data,
          organisationId: user.organisationId,
          userId,
          employeeCode: (dto.employeeCode ?? profile?.employeeCode)!,
        },
      });
    });
    const row = await this.detail(user, userId);
    await this.audit.record(user, {
      action: 'employee.update',
      entityType: 'User',
      entityId: userId,
      storeId: target.userStores[0]?.storeId ?? null,
      summary: `Updated employee ${row.name}`,
      metadata: { before, after: this.auditView(row) },
    });
    return row;
  }

  /** DELETE /hrms/employees/:userId — separate; `purge` (head office) also drops a history-free profile. */
  async separate(user: AuthUser, userId: string, dto: SeparateEmployeeDto, purge = false) {
    const target = await this.loadVisible(user, userId);
    this.assertCanManage(user, target);
    if (userId === user.id) throw new BadRequestException('You cannot separate yourself');
    const before = this.auditView((await this.toRows(user, [target]))[0]);

    if (purge) {
      if (user.role !== 'head_office')
        throw new ForbiddenException('Only head office can purge an employee record');
      if (!target.employeeProfile) throw new NotFoundException('This person has no employee record');
      const [att, leave, slips, punches] = await Promise.all([
        this.prisma.attendanceRecord.count({ where: { staffId: userId } }),
        this.prisma.leaveRequest.count({ where: { staffId: userId } }),
        this.prisma.payslip.count({ where: { userId } }),
        this.prisma.rawPunchEvent.count({ where: { userId } }),
      ]);
      if (att + leave + slips + punches) {
        throw new ConflictException(
          'This person has attendance, leave or payslip history. Separate them instead so the history stays.',
        );
      }
      await this.prisma.$transaction([
        this.prisma.employeeProfile.delete({ where: { userId } }),
        this.prisma.shiftAssignment.deleteMany({ where: { userId } }),
        this.prisma.user.update({
          where: { id: userId },
          data: { isActive: false, googleSub: null },
        }),
      ]);
      await this.audit.record(user, {
        action: 'employee.purge',
        entityType: 'User',
        entityId: userId,
        storeId: target.userStores[0]?.storeId ?? null,
        summary: `Removed the employee record of ${target.name}`,
        metadata: { before, after: null },
      });
      return { userId, purged: true };
    }

    const exitDate = dto.exitDate ? ymd(dto.exitDate) : businessDate(new Date(), await this.tzOf(target));
    await this.prisma.$transaction([
      // Unlink Google so a reactivated user doesn't silently regain access (same as users.deactivate).
      this.prisma.user.update({
        where: { id: userId },
        data: { isActive: false, googleSub: null },
      }),
      ...(target.employeeProfile
        ? [
            this.prisma.employeeProfile.update({
              where: { userId },
              data: {
                status: 'separated',
                exitDate,
                exitReason: dto.exitReason?.trim() || null,
              },
            }),
          ]
        : []),
    ]);
    const row = await this.detail(user, userId);
    await this.audit.record(user, {
      action: 'employee.separate',
      entityType: 'User',
      entityId: userId,
      storeId: target.userStores[0]?.storeId ?? null,
      summary: `Separated ${target.name} from ${dateOnly(exitDate)}`,
      metadata: { before, after: this.auditView(row) },
    });
    return row;
  }

  async bulk(user: AuthUser, dto: BulkEmployeesDto) {
    const done: string[] = [];
    const failed: { userId: string; reason: string }[] = [];
    for (const userId of [...new Set(dto.userIds)]) {
      try {
        if (dto.action === 'separate') await this.separate(user, userId, {});
        else await this.setActive(user, userId, dto.action === 'activate');
        done.push(userId);
      } catch (err) {
        failed.push({ userId, reason: (err as Error).message });
      }
    }
    return { action: dto.action, done, failed };
  }

  private async setActive(user: AuthUser, userId: string, active: boolean) {
    const target = await this.loadVisible(user, userId);
    this.assertCanManage(user, target);
    if (userId === user.id) throw new BadRequestException('You cannot change your own access');
    if (active && target.employeeProfile?.status === 'separated' && user.role !== 'head_office') {
      throw new ForbiddenException('Only head office can bring back someone who has been separated');
    }
    const before = this.auditView((await this.toRows(user, [target]))[0]);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: active ? { isActive: true } : { isActive: false, googleSub: null },
      }),
      ...(target.employeeProfile
        ? [
            this.prisma.employeeProfile.update({
              where: { userId },
              data: active ? { status: 'active', exitDate: null, exitReason: null } : { status: 'inactive' },
            }),
          ]
        : []),
    ]);
    const row = await this.detail(user, userId);
    await this.audit.record(user, {
      action: active ? 'employee.activate' : 'employee.deactivate',
      entityType: 'User',
      entityId: userId,
      storeId: target.userStores[0]?.storeId ?? null,
      summary: `${active ? 'Activated' : 'Deactivated'} ${target.name}`,
      metadata: { before, after: this.auditView(row) },
    });
  }

  // ==========================================================================
  // EzAttendancePRO import
  // ==========================================================================

  /**
   * POST /hrms/import/ezattendance. Everything runs in ONE transaction; a dry run
   * is the same run rolled back, so the preview cannot drift from the apply.
   */
  async importEzAttendance(
    user: AuthUser,
    files: { employees?: Upload; leaveBalances?: Upload; todaysPunch?: Upload },
    opts: {
      dryRun: boolean;
      departmentStores?: string;
      attendanceDate?: string;
    },
  ) {
    if (!files.employees?.buffer) throw new BadRequestException('Attach the employee master (employees)');
    const employees = parseCsv(files.employees.buffer.toString('utf8'));
    if (!employees.length || !('Employee Code' in employees[0]) || !('Employee Name' in employees[0])) {
      throw new BadRequestException('The employee file needs "Employee Code" and "Employee Name" columns');
    }
    const leave = files.leaveBalances?.buffer ? parseCsv(files.leaveBalances.buffer.toString('utf8')) : [];
    const punch = files.todaysPunch?.buffer ? parseCsv(files.todaysPunch.buffer.toString('utf8')) : [];

    let mapping: Record<string, string | null> = {};
    if (opts.departmentStores) {
      try {
        mapping = JSON.parse(opts.departmentStores);
      } catch {
        throw new BadRequestException('departmentStores must be JSON');
      }
      if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
        throw new BadRequestException('departmentStores must be an object of department name to store id');
      }
    }
    const mapByKey = new Map<string, string | null>();
    for (const [k, v] of Object.entries(mapping)) {
      if (v !== null && typeof v !== 'string')
        throw new BadRequestException(`Store for "${k}" must be an id or null`);
      if (v) await this.assertOrgStore(user, v);
      mapByKey.set(normKey(k), v || null);
    }

    const fileDate = /(\d{4}-\d{2}-\d{2})/.exec(files.todaysPunch?.originalname ?? '')?.[1];
    const attendanceDay = opts.attendanceDate ?? fileDate;
    if (attendanceDay && !/^\d{4}-\d{2}-\d{2}$/.test(attendanceDay)) {
      throw new BadRequestException('attendanceDate must be YYYY-MM-DD');
    }
    const leaveYear =
      Number(/(20\d{2})/.exec(files.leaveBalances?.originalname ?? '')?.[1]) ||
      (attendanceDay ? Number(attendanceDay.slice(0, 4)) : new Date().getUTCFullYear());

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const result = await this.runImport(
            tx,
            user,
            employees,
            leave,
            punch,
            mapByKey,
            attendanceDay,
            leaveYear,
          );
          if (opts.dryRun) throw new DryRun({ ...result, dryRun: true });
          return { ...result, dryRun: false };
        },
        { timeout: 120_000, maxWait: 10_000 },
      );
    } catch (err) {
      if (err instanceof DryRun) return err.result;
      throw err;
    }
  }

  private async runImport(
    tx: Tx,
    user: AuthUser,
    rows: Record<string, string>[],
    leaveRows: Record<string, string>[],
    punchRows: Record<string, string>[],
    mapByKey: Map<string, string | null>,
    attendanceDay: string | undefined,
    leaveYear: number,
  ) {
    const org = user.organisationId;
    const exceptions: { code: string; field: string; issue: string }[] = [];
    const stores = new Map(
      (
        await tx.store.findMany({
          where: { organisationId: org, isAggregate: false },
          select: { id: true, name: true, timezone: true },
        })
      ).map((s) => [s.id, s]),
    );

    // --- Masters: one row per case-insensitive name ---------------------------
    const departments = new Map(
      (await tx.department.findMany({ where: { organisationId: org } })).map((d) => [normKey(d.name), d]),
    );
    const designations = new Map(
      (await tx.designation.findMany({ where: { organisationId: org } })).map((d) => [normKey(d.name), d]),
    );
    const createdDepartments: string[] = [];
    const createdDesignations: string[] = [];
    const mapped: Record<string, string | null> = {};

    for (const raw of new Set(rows.map((r) => r['DEPARTMENT'] ?? '').filter(Boolean))) {
      const key = normKey(raw);
      let dept = departments.get(key);
      const wanted = mapByKey.has(key) ? mapByKey.get(key)! : (dept?.storeId ?? null);
      if (!dept) {
        dept = await tx.department.create({
          data: { organisationId: org, name: titleCase(raw), storeId: wanted },
        });
        departments.set(key, dept);
        createdDepartments.push(dept.name);
      } else if (dept.storeId !== wanted) {
        const before = dept;
        dept = await tx.department.update({
          where: { id: dept.id },
          data: { storeId: wanted },
        });
        departments.set(key, dept);
        await this.audit.record(
          user,
          {
            action: 'department.update',
            entityType: 'Department',
            entityId: dept.id,
            summary: `Mapped department ${dept.name} to ${wanted ? stores.get(wanted)?.name : 'no store'} (import)`,
            metadata: { before, after: dept },
          },
          tx,
        );
      }
      mapped[dept.name] = dept.storeId;
    }
    for (const raw of new Set(rows.map((r) => r['DESIGNATION'] ?? '').filter(Boolean))) {
      const key = normKey(raw);
      if (designations.has(key)) continue;
      const d = await tx.designation.create({
        data: { organisationId: org, name: titleCase(raw) },
      });
      designations.set(key, d);
      createdDesignations.push(d.name);
    }

    // --- Existing people ---------------------------------------------------------
    const orgUsers = await tx.user.findMany({
      where: { organisationId: org, approvalStatus: 'approved' },
      include: {
        employeeProfile: true,
        userStores: {
          include: { store: { select: { name: true } } },
          orderBy: { isPrimary: 'desc' },
        },
      },
    });
    const byCode = new Map(
      orgUsers
        .filter((u) => u.employeeProfile)
        .map((u) => [u.employeeProfile!.employeeCode.toLowerCase(), u]),
    );
    const orgMeta = await tx.organisation.findUniqueOrThrow({
      where: { id: org },
      select: { slug: true, settings: true },
    });
    const policy = readSignupPolicy(orgMeta.settings);

    // --- Shifts: seed the EzAttendance codes a store actually uses -------------
    const shifts = new Map<string, ShiftLike & { id: string }>();
    for (const s of await tx.shift.findMany({
      where: { organisationId: org, code: { not: null } },
    })) {
      shifts.set(`${s.storeId}|${s.code!.toUpperCase()}`, s);
    }
    const seededShifts: { storeId: string; code: string }[] = [];
    const storeOfRow = (r: Record<string, string>) =>
      departments.get(normKey(r['DEPARTMENT'] ?? ''))?.storeId ?? null;
    for (const r of rows) {
      const storeId = storeOfRow(r);
      const code = (r['Shift'] ?? '').trim().toUpperCase();
      if (!storeId || !code || shifts.has(`${storeId}|${code}`) || !DEFAULT_SHIFTS[code]) continue;
      const s = await tx.shift.create({
        data: { organisationId: org, storeId, code, ...DEFAULT_SHIFTS[code] },
      });
      shifts.set(`${storeId}|${code}`, s);
      seededShifts.push({ storeId, code });
    }

    // --- Employees ---------------------------------------------------------------
    const today = attendanceDay ? ymd(attendanceDay) : businessDate(new Date(), DEFAULT_TZ);
    const out = {
      created: 0,
      updated: 0,
      unchanged: 0,
      rows: [] as {
        code: string;
        name: string;
        action: string;
        changes: string[];
      }[],
    };
    const matched = new Set<string>();
    const userByCode = new Map<string, { id: string; name: string; storeId: string | null }>();

    for (const r of rows) {
      const code = (r['Employee Code'] ?? '').trim();
      const name = (r['Employee Name'] ?? '').replace(/\s+/g, ' ').trim();
      if (!code || !name) {
        exceptions.push({
          code: code || '?',
          field: 'Employee Code',
          issue: 'row without a code or name was skipped',
        });
        continue;
      }
      if (userByCode.has(code.toLowerCase())) {
        exceptions.push({
          code,
          field: 'Employee Code',
          issue: 'code appears twice in the file; later row skipped',
        });
        continue;
      }

      // Match: code, then phone, then exact (case-insensitive) name among people without a profile.
      const phone = last10(Object.entries(r).find(([k]) => /mobile|phone/i.test(k))?.[1]);
      let target = byCode.get(code.toLowerCase());
      if (!target && phone) {
        const hits = orgUsers.filter((u) => !u.employeeProfile && last10(u.phone) === phone);
        if (hits.length === 1) target = hits[0];
      }
      if (!target) {
        const hits = orgUsers.filter(
          (u) => !u.employeeProfile && !matched.has(u.id) && normKey(u.name) === normKey(name),
        );
        if (hits.length > 1) {
          exceptions.push({
            code,
            field: 'Employee Name',
            issue: `${hits.length} existing people share this name; row skipped, link it by hand`,
          });
          continue;
        }
        target = hits[0];
      }
      if (target && matched.has(target.id)) {
        exceptions.push({
          code,
          field: 'Employee Code',
          issue: 'matches a person already matched by another row; skipped',
        });
        continue;
      }

      const desired = this.importProfile(r, code, departments, designations, exceptions);
      const storeId = storeOfRow(r);
      const shiftCode = desired.shiftCode?.toUpperCase();
      const shift = storeId && shiftCode ? shifts.get(`${storeId}|${shiftCode}`) : undefined;
      if (shiftCode && !DEFAULT_SHIFTS[shiftCode] && !shift) {
        exceptions.push({
          code,
          field: 'Shift',
          issue: `unknown shift code "${desired.shiftCode}"`,
        });
      }

      let userId: string;
      const changes: string[] = [];
      if (!target) {
        const role: Role =
          normKey(r['DESIGNATION'] ?? '') === 'store manager' ? 'store_manager' : 'salesperson';
        const subject = {
          name,
          storeName: (storeId && stores.get(storeId)?.name) || r['DEPARTMENT'] || 'office',
          organisationSlug: orgMeta.slug,
        };
        const u = await allocateLoginId(
          (n) => renderLoginId(policy.loginIdTemplate, subject, n),
          (email) =>
            withSavepoint(tx, () =>
              tx.user.create({
                data: {
                  organisationId: org,
                  name,
                  email,
                  phone: phone ?? null,
                  contactEmail: desired.personalEmail?.toLowerCase() ?? null,
                  initials: initialsOf(name),
                  role,
                  isActive: false,
                  passwordHash: null,
                  ...(storeId ? { userStores: { create: { storeId, isPrimary: true } } } : {}),
                },
              }),
            ),
        );
        await tx.employeeProfile.create({
          data: {
            organisationId: org,
            userId: u.id,
            employeeCode: code,
            ...desired,
          },
        });
        userId = u.id;
        await this.assignImportShift(tx, user, userId, shift, today, desired.dateOfJoining);
        out.created++;
        out.rows.push({ code, name, action: 'create', changes: [] });
        await this.audit.record(
          user,
          {
            action: 'employee.create',
            entityType: 'User',
            entityId: u.id,
            storeId,
            summary: `Imported employee ${name} (${code}) from EzAttendance`,
            metadata: {
              before: null,
              after: redactPersonal({
                employeeCode: code,
                role,
                storeId,
                ...desired,
                sourceRaw: undefined,
              }),
            },
          },
          tx,
        );
      } else {
        userId = target.id;
        const existing = target.employeeProfile;
        const beforeProfile: Record<string, unknown> = {};
        const afterProfile: Record<string, unknown> = {};
        for (const f of IMPORT_FIELDS) {
          if (!existing || !same(existing[f], desired[f])) {
            changes.push(f);
            beforeProfile[f] = existing?.[f] ?? null;
            afterProfile[f] = desired[f];
          }
        }
        if (!existing) changes.unshift('employeeCode');
        if (changes.length) {
          await tx.employeeProfile.upsert({
            where: { userId },
            update: desired,
            create: {
              organisationId: org,
              userId,
              employeeCode: code,
              ...desired,
            },
          });
        }
        if (storeId && !target.userStores.some((s) => s.storeId === storeId)) {
          await tx.userStore.create({
            data: {
              userId,
              storeId,
              isPrimary: target.userStores.length === 0,
            },
          });
          changes.push('stores');
          afterProfile.storeId = storeId;
        }
        if (await this.assignImportShift(tx, user, userId, shift, today, desired.dateOfJoining)) {
          changes.push('shift');
          afterProfile.shiftId = shift!.id;
        }
        if (changes.length) {
          out.updated++;
          await this.audit.record(
            user,
            {
              action: 'employee.update',
              entityType: 'User',
              entityId: userId,
              storeId,
              summary: `Updated ${target.name} (${code}) from EzAttendance: ${changes.join(', ')}`,
              metadata: {
                before: redactPersonal({ ...beforeProfile, sourceRaw: undefined }),
                after: redactPersonal({ ...afterProfile, sourceRaw: undefined }),
              },
            },
            tx,
          );
        } else out.unchanged++;
        out.rows.push({
          code,
          name,
          action: changes.length ? 'update' : 'unchanged',
          changes,
        });
      }

      matched.add(userId);
      const links = target?.userStores ?? [];
      userByCode.set(code.toLowerCase(), {
        id: userId,
        name: target?.name ?? name,
        storeId: storeId ?? links[0]?.storeId ?? null,
      });
    }

    // --- Leave balances ------------------------------------------------------------
    const leaveOut = {
      upserted: 0,
      unchanged: 0,
      year: leaveYear,
      skipped: [] as { code: string; reason: string }[],
    };
    for (const r of leaveRows) {
      const code = (r['Employee Code'] ?? '').trim();
      const who = userByCode.get(code.toLowerCase());
      const type = LEAVE_TYPE_MAP[(r['Leave Type'] ?? '').trim().toUpperCase()] as LeaveType | undefined;
      const allocated = Number(r['Opening Balance']);
      const used = Number(r['Leave Used']);
      if (!who) {
        leaveOut.skipped.push({ code, reason: 'not in the employee master' });
        continue;
      }
      if (!type) {
        leaveOut.skipped.push({
          code,
          reason: `unknown leave type "${r['Leave Type']}"`,
        });
        continue;
      }
      if (!Number.isFinite(allocated) || !Number.isFinite(used) || allocated < 0 || used < 0) {
        leaveOut.skipped.push({
          code,
          reason: 'opening balance or leave used is not a number',
        });
        continue;
      }
      const existing = await tx.leaveBalance.findUnique({
        where: { userId_type_year: { userId: who.id, type, year: leaveYear } },
      });
      if (existing && Number(existing.allocated) === allocated && Number(existing.used) === used) {
        leaveOut.unchanged++;
        continue;
      }
      await tx.leaveBalance.upsert({
        where: { userId_type_year: { userId: who.id, type, year: leaveYear } },
        update: { allocated, used },
        create: {
          userId: who.id,
          storeId: who.storeId,
          type,
          year: leaveYear,
          allocated,
          used,
        },
      });
      leaveOut.upserted++;
      await this.audit.record(
        user,
        {
          action: 'leave_balance.import',
          entityType: 'LeaveBalance',
          entityId: existing?.id ?? `${who.id}:${type}:${leaveYear}`,
          storeId: who.storeId,
          summary: `Imported ${type} balance for ${who.name} (${code}): ${allocated} allocated, ${used} used`,
          metadata: {
            before: existing
              ? {
                  allocated: Number(existing.allocated),
                  used: Number(existing.used),
                }
              : null,
            after: { allocated, used },
          },
        },
        tx,
      );
    }

    // --- Today's punch ---------------------------------------------------------------
    const attOut = {
      date: dateOnly(today),
      upserted: 0,
      unchanged: 0,
      skipped: [] as { code: string; reason: string }[],
    };
    if (punchRows.length) {
      const month = dateOnly(today).slice(0, 7);
      const lock = await tx.payrollPeriodLock.findFirst({
        where: { organisationId: org, month, reopenedAt: null },
      });
      for (const r of punchRows) {
        const code = (r['Employee Code'] ?? '').trim();
        const who = userByCode.get(code.toLowerCase());
        if (lock) {
          attOut.skipped.push({
            code,
            reason: `Payroll for ${month} is locked`,
          });
          continue;
        }
        if (!who) {
          attOut.skipped.push({ code, reason: 'not in the employee master' });
          continue;
        }
        if (!who.storeId) {
          attOut.skipped.push({
            code,
            reason: 'no store (map the department to a store)',
          });
          continue;
        }
        const store = stores.get(who.storeId)!;
        const tz = resolveTz(store.timezone);
        const statusText = normKey(r['Status'] ?? '');
        const inMins = parseClock(r['IN']);
        let status: AttendanceStatus;
        if (statusText === 'present' || statusText === 'late') {
          if (inMins == null) {
            attOut.skipped.push({ code, reason: 'present without an IN time' });
            continue;
          }
          status = 'present';
        } else if (statusText === 'absent') status = 'absent';
        else if (statusText === 'leave') status = 'on_leave';
        else if (/week ?off|^wo$/.test(statusText)) status = 'week_off';
        else if (statusText === 'holiday') status = 'holiday';
        else {
          attOut.skipped.push({
            code,
            reason: `unknown status "${r['Status']}"`,
          });
          continue;
        }
        const shiftCode = (r['Shift'] ?? '').trim().toUpperCase();
        const shift = shiftCode ? shifts.get(`${who.storeId}|${shiftCode}`) : undefined;
        const lateMins = parseClock(r['Late']);
        let isLate =
          status === 'present' && (lateMins != null ? lateMins > 0 : normKey(r['Reason'] ?? '') === 'late');
        if (isLate && shift?.isFlexible) {
          isLate = false;
          exceptions.push({
            code,
            field: 'Late',
            issue: 'marked late on a flexible shift; lateness not imported',
          });
        }
        const data = {
          staffName: who.name,
          status,
          checkInAt: status === 'present' ? instantFromLocalTime(today, inMins!, tz) : null,
          shiftId: status === 'present' ? (shift?.id ?? null) : null,
          isLate,
          lateMinutes: isLate ? lateMins : null,
          dayFraction: status === 'present' ? new Prisma.Decimal(1) : new Prisma.Decimal(0),
          source: 'import',
          calculationVersion: ATTENDANCE_CALCULATION_VERSION,
          shiftSnapshot:
            status === 'present' && shift ? snapshotShift(shift) : Prisma.DbNull,
        };

        const existing = await tx.attendanceRecord.findUnique({
          where: {
            storeId_staffId_date: {
              storeId: who.storeId,
              staffId: who.id,
              date: today,
            },
          },
        });
        if (existing && PROTECTED_SOURCES.includes(existing.source)) {
          attOut.skipped.push({
            code,
            reason: `already recorded in the app (${existing.source})`,
          });
          continue;
        }
        const unchanged =
          existing &&
          existing.source === 'import' &&
          existing.calculationVersion === ATTENDANCE_CALCULATION_VERSION &&
          existing.status === data.status &&
          existing.isLate === data.isLate &&
          existing.lateMinutes === data.lateMinutes &&
          existing.shiftId === data.shiftId &&
          (existing.checkInAt?.getTime() ?? null) === (data.checkInAt?.getTime() ?? null) &&
          Number(existing.dayFraction) === Number(data.dayFraction);
        if (unchanged) attOut.unchanged++;
        else {
          const row = await tx.attendanceRecord.upsert({
            where: {
              storeId_staffId_date: {
                storeId: who.storeId,
                staffId: who.id,
                date: today,
              },
            },
            update: data,
            create: {
              ...data,
              organisationId: org,
              storeId: who.storeId,
              staffId: who.id,
              date: today,
            },
          });
          attOut.upserted++;
          await this.audit.record(
            user,
            {
              action: 'attendance.import',
              entityType: 'AttendanceRecord',
              entityId: row.id,
              storeId: who.storeId,
              summary: `Imported ${status} for ${who.name} (${code}) on ${dateOnly(today)}`,
              metadata: {
                before: existing
                  ? {
                      status: existing.status,
                      isLate: existing.isLate,
                      checkInAt: existing.checkInAt,
                    }
                  : null,
                after: { status, isLate, checkInAt: data.checkInAt },
              },
            },
            tx,
          );
        }
        if (data.checkInAt) {
          // Retries are unique inside the tenant; employee codes repeat across tenants.
          const idempotencyKey = `ezatt:${org}:${code}:${dateOnly(today)}:in`;
          const seen = await tx.rawPunchEvent.findUnique({
            where: {
              organisationId_idempotencyKey: {
                organisationId: org,
                idempotencyKey,
              },
            },
          });
          if (!seen) {
            await tx.rawPunchEvent.create({
              data: {
                organisationId: org,
                userId: who.id,
                storeId: who.storeId,
                kind: 'in',
                eventAt: data.checkInAt,
                source: 'import',
                externalId: code,
                idempotencyKey,
                createdById: user.id,
                note: 'EzAttendance import',
              },
            });
          }
        }
      }
    }

    const notInSource = orgUsers
      .filter((u) => u.isActive && u.role !== 'head_office' && u.id !== user.id && !matched.has(u.id))
      .map((u) => ({
        userId: u.id,
        name: u.name,
        role: u.role,
        storeNames: u.userStores.map((s) => s.store.name),
      }));

    await this.audit.record(
      user,
      {
        action: 'employee.import_ezattendance',
        entityType: 'Organisation',
        entityId: org,
        summary: `EzAttendance import: ${out.created} created, ${out.updated} updated, ${out.unchanged} unchanged`,
        metadata: {
          employees: {
            created: out.created,
            updated: out.updated,
            unchanged: out.unchanged,
          },
          departmentsCreated: createdDepartments,
          designationsCreated: createdDesignations,
          leaveBalances: {
            upserted: leaveOut.upserted,
            skipped: leaveOut.skipped.length,
          },
          attendance: {
            date: attOut.date,
            upserted: attOut.upserted,
            skipped: attOut.skipped.length,
          },
        },
      },
      tx,
    );

    return {
      employees: out,
      departments: { created: createdDepartments, mapped },
      designations: { created: createdDesignations },
      shifts: { created: seededShifts },
      leaveBalances: leaveOut,
      attendance: attOut,
      notInSource,
      exceptions,
    };
  }

  /** Point the person at the store's shift for their code. True when something changed. */
  private async assignImportShift(
    tx: Tx,
    user: AuthUser,
    userId: string,
    shift: { id: string } | undefined,
    today: Date,
    dateOfJoining: Date | null,
  ): Promise<boolean> {
    if (!shift) return false;
    const open = await tx.shiftAssignment.findFirst({
      where: { userId, effectiveTo: null },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (open?.shiftId !== shift.id) {
      if (open && open.effectiveFrom >= today) {
        await tx.shiftAssignment.update({
          where: { id: open.id },
          data: { shiftId: shift.id },
        });
      } else {
        if (open) {
          await tx.shiftAssignment.update({
            where: { id: open.id },
            data: { effectiveTo: new Date(today.getTime() - 86_400_000) },
          });
        }
        await tx.shiftAssignment.create({
          data: {
            organisationId: user.organisationId,
            userId,
            shiftId: shift.id,
            effectiveFrom: open ? today : (dateOfJoining ?? today),
            createdById: user.id,
          },
        });
      }
      return true;
    }
    return false;
  }

  /** One employee row -> the profile columns the importer owns. */
  private importProfile(
    r: Record<string, string>,
    code: string,
    departments: Map<string, { id: string }>,
    designations: Map<string, { id: string }>,
    exceptions: { code: string; field: string; issue: string }[],
  ) {
    const date = (field: string) => {
      const v = parseDmy(r[field]);
      if (v === 'invalid') {
        exceptions.push({
          code,
          field,
          issue: `"${r[field]}" is not a DD/MM/YYYY date`,
        });
        return null;
      }
      if (v === null && r[field] === '01/01/1900')
        exceptions.push({
          code,
          field,
          issue: 'placeholder date 01/01/1900 treated as missing',
        });
      return v;
    };
    const email = r['Email ID']?.trim() || null;
    if (email) {
      const issue = emailIssue(email);
      if (issue) exceptions.push({ code, field: 'Email ID', issue });
    }
    const gender = (r['Gender'] ?? '').trim().toUpperCase();
    if (gender && gender !== 'M' && gender !== 'F')
      exceptions.push({
        code,
        field: 'Gender',
        issue: `unknown gender "${r['Gender']}"`,
      });
    const text = (v: string | undefined) => v?.trim() || null;
    return {
      biometricNo: text(r['Biometric No.']),
      departmentId: r['DEPARTMENT'] ? (departments.get(normKey(r['DEPARTMENT']))?.id ?? null) : null,
      designationId: r['DESIGNATION'] ? (designations.get(normKey(r['DESIGNATION']))?.id ?? null) : null,
      unit: text(r['UNIT']),
      gender: gender === 'M' || gender === 'F' ? gender : null,
      dateOfBirth: date('DOB'),
      dateOfJoining: date('DOJ'),
      dateOfConfirmation: date('DOC'),
      bloodGroup: text(r['Blood Grp']),
      address: text(r['Address']),
      personalEmail: email,
      shiftCode: text(r['Shift']),
      source: 'ezattendance',
      sourceRaw: r as Prisma.InputJsonObject,
    };
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /** Staff visible to the caller: head office the whole org, a manager their stores' people. */
  private visibleWhere(user: AuthUser, storeId?: string): Prisma.UserWhereInput {
    const base: Prisma.UserWhereInput = {
      organisationId: user.organisationId,
      approvalStatus: 'approved',
      // Below head office, only people ranked strictly below the caller.
      ...(user.role === 'head_office'
        ? {}
        : {
            role: {
              in: (Object.keys(ROLE_RANK) as Role[]).filter((r) => ROLE_RANK[r] < ROLE_RANK[user.role]),
            },
          }),
    };
    if (user.allStores && (!storeId || storeId === 'all')) return base;
    const ids = this.scope.effectiveStoreIds(user, storeId);
    return { ...base, userStores: { some: { storeId: { in: ids } } } };
  }

  private async loadVisible(user: AuthUser, userId: string): Promise<EmployeeUser> {
    const target = await this.prisma.user.findFirst({
      where: { ...this.visibleWhere(user), id: userId },
      include: EMPLOYEE_INCLUDE,
    });
    if (!target) throw new NotFoundException('Employee not found');
    return target;
  }

  /** Managers act on people strictly below them; head office on anyone in the organisation. */
  private assertCanManage(user: AuthUser, target: { role: Role }) {
    if (user.role !== 'head_office' && ROLE_RANK[target.role] >= ROLE_RANK[user.role]) {
      throw new ForbiddenException('You cannot manage someone at or above your own role');
    }
  }

  private async toRows(user: AuthUser, users: EmployeeUser[]) {
    const ids = users.map((u) => u.id);
    const managerIds = [
      ...new Set(users.map((u) => u.employeeProfile?.reportingManagerId).filter((v): v is string => !!v)),
    ];
    const today = businessDate(new Date(), DEFAULT_TZ);
    const [assignments, managers] = await Promise.all([
      this.prisma.shiftAssignment.findMany({
        where: {
          userId: { in: ids },
          effectiveFrom: { lte: today },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
        },
        orderBy: { effectiveFrom: 'desc' },
      }),
      this.prisma.user.findMany({
        where: { id: { in: managerIds } },
        select: { id: true, name: true },
      }),
    ]);
    const shifts = new Map(
      (
        await this.prisma.shift.findMany({
          where: {
            id: { in: [...new Set(assignments.map((a) => a.shiftId))] },
          },
          select: { id: true, name: true, startTime: true, endTime: true },
        })
      ).map((s) => [s.id, s]),
    );
    const shiftOf = new Map<string, string>();
    for (const a of assignments) if (!shiftOf.has(a.userId)) shiftOf.set(a.userId, a.shiftId);
    const managerName = new Map(managers.map((m) => [m.id, m.name]));
    const d = (v: Date | null | undefined) => (v ? dateOnly(v) : null);
    // Date of birth, blood group and address are head office's alone.
    const seesPersonal = user.role === 'head_office';

    return users.map((u) => {
      const p = u.employeeProfile;
      // A scoped manager is not shown the names of stores outside their reach.
      const links = u.userStores.filter((s) => user.allStores || user.storeIds.includes(s.storeId));
      return {
        userId: u.id,
        employeeCode: p?.employeeCode ?? null,
        name: u.name,
        phone: u.phone,
        loginEmail: u.email,
        personalEmail: p?.personalEmail ?? u.contactEmail ?? null,
        role: u.role,
        isActive: u.isActive,
        storeIds: links.map((s) => s.storeId),
        storeNames: links.map((s) => s.store.name),
        department: p?.department ?? null,
        designation: p?.designation ?? null,
        unit: p?.unit ?? null,
        gender: p?.gender ?? null,
        dateOfBirth: seesPersonal ? d(p?.dateOfBirth) : null,
        dateOfJoining: d(p?.dateOfJoining),
        dateOfConfirmation: d(p?.dateOfConfirmation),
        exitDate: d(p?.exitDate),
        exitReason: p?.exitReason ?? null,
        employmentType: p?.employmentType ?? null,
        status: p?.status ?? (u.isActive ? 'active' : 'inactive'),
        bloodGroup: seesPersonal ? (p?.bloodGroup ?? null) : null,
        address: seesPersonal ? (p?.address ?? null) : null,
        biometricNo: p?.biometricNo ?? null,
        shiftCode: p?.shiftCode ?? null,
        currentShift: shifts.get(shiftOf.get(u.id) ?? '') ?? null,
        reportingManager:
          p?.reportingManagerId && managerName.has(p.reportingManagerId)
            ? {
                id: p.reportingManagerId,
                name: managerName.get(p.reportingManagerId)!,
              }
            : null,
        source: p?.source ?? null,
        hasProfile: !!p,
      };
    });
  }

  /** The audit before/after view: the row minus bulky evidence. */
  private auditView(row: Record<string, unknown>) {
    return redactPersonal(this.withoutEvidence(row));
  }

  private withoutEvidence(row: Record<string, unknown>) {
    const {
      leaveBalances: _l,
      recentAttendance: _a,
      ...rest
    } = row as Record<string, unknown> & {
      leaveBalances?: unknown;
      recentAttendance?: unknown;
    };
    return rest;
  }

  private profileData(dto: EmployeeProfileFieldsDto) {
    const data: Record<string, unknown> = {};
    for (const f of TEXT_FIELDS) {
      const v = dto[f];
      if (v !== undefined) data[f] = typeof v === 'string' ? v.trim() || null : v;
    }
    if (data.employmentType === null) delete data.employmentType;
    if (typeof data.personalEmail === 'string') data.personalEmail = data.personalEmail.toLowerCase();
    for (const f of DATE_FIELDS) {
      const v = dto[f];
      if (v !== undefined) data[f] = v ? ymd(v) : null;
    }
    for (const f of ['departmentId', 'designationId', 'reportingManagerId'] as const) {
      if (dto[f] !== undefined) data[f] = dto[f] || null;
    }
    return data as Omit<
      Prisma.EmployeeProfileUncheckedCreateInput,
      'organisationId' | 'userId' | 'employeeCode'
    >;
  }

  private async assertProfileRefs(user: AuthUser, dto: EmployeeProfileFieldsDto) {
    const org = user.organisationId;
    if (
      dto.departmentId &&
      !(await this.prisma.department.count({
        where: { id: dto.departmentId, organisationId: org },
      }))
    ) {
      throw new BadRequestException('Unknown department');
    }
    if (
      dto.designationId &&
      !(await this.prisma.designation.count({
        where: { id: dto.designationId, organisationId: org },
      }))
    ) {
      throw new BadRequestException('Unknown designation');
    }
    if (
      dto.reportingManagerId &&
      !(await this.prisma.user.count({
        where: { id: dto.reportingManagerId, organisationId: org },
      }))
    ) {
      throw new BadRequestException('Unknown reporting manager');
    }
  }

  private async assertCodeFree(organisationId: string, employeeCode: string) {
    const taken = await this.prisma.employeeProfile.findFirst({
      where: { organisationId, employeeCode },
    });
    if (taken) throw new ConflictException(`Employee code ${employeeCode} is already in use`);
  }

  /** Every store must be in scope and a real branch of this organisation. */
  private async assertStores(user: AuthUser, storeIds: string[]) {
    for (const id of storeIds) this.scope.assertStoreAllowed(user, id);
    const stores = await this.prisma.store.findMany({
      where: {
        id: { in: storeIds },
        organisationId: user.organisationId,
        isAggregate: false,
      },
      select: { id: true, name: true },
    });
    if (stores.length !== storeIds.length) throw new BadRequestException('Choose valid stores');
    return storeIds.map((id) => stores.find((s) => s.id === id)!);
  }

  private async assertOrgStore(user: AuthUser, storeId: string) {
    const ok = await this.prisma.store.count({
      where: {
        id: storeId,
        organisationId: user.organisationId,
        isAggregate: false,
      },
    });
    if (!ok) throw new BadRequestException(`Unknown store ${storeId}`);
  }

  private async storeNames(organisationId: string, db: Db = this.prisma) {
    const stores = await db.store.findMany({
      where: { organisationId },
      select: { id: true, name: true },
    });
    return new Map(stores.map((s) => [s.id, s.name]));
  }

  private async tzOf(target: EmployeeUser) {
    const storeId = target.userStores[0]?.storeId;
    if (!storeId) return DEFAULT_TZ;
    const s = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { timezone: true },
    });
    return resolveTz(s?.timezone);
  }

  /** A duplicate master name is a 409, not a 500. */
  private async uniqueName<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('That name is already in use');
      }
      throw err;
    }
  }

  private auditMaster(
    user: AuthUser,
    action: string,
    entityType: string,
    entityId: string,
    before: unknown,
    after: unknown,
  ) {
    const name =
      (after as { name?: string } | null)?.name ?? (before as { name?: string } | null)?.name ?? entityId;
    return this.audit.record(user, {
      action,
      entityType,
      entityId,
      summary: `${action.split('.')[1]} ${entityType.toLowerCase()} ${name}`,
      metadata: { before, after },
    });
  }
}
