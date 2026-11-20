import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import type { PrismaService } from '../src/prisma/prisma.service';
import { parseCsv, parseDmy, titleCase } from '../src/hrms/ezattendance-import';

/**
 * Employee master, departments/designations and the EzAttendancePRO import
 * (docs/modules/06-attendance.md, "Masters and employees").
 *
 * Every row here is synthetic (ZZ9xx "Test Person"). The real export holds
 * personal data and never enters the repository.
 */

const PASSWORD = 'password123';
const A = {
  org: 'org_emp_a',
  slug: 'emp-a',
  bandra: 'store_emp_bandra',
  andheri: 'store_emp_andheri',
  ho: 'ho.emp@emp-a.local',
  mgr: 'mgr.emp@emp-a.local',
  rep: 'rep.emp@emp-a.local',
  repB: 'repb.emp@emp-a.local',
};

const MASTER_HEADER =
  'Sr.No.,Employee Code,Employee Name,Biometric No.,Shift,Gender,Swipe,Designation (personal field),DOB,DOJ,DOC,Email ID,Address,Blood Grp,UNIT,DEPARTMENT,DESIGNATION';
const MASTER = [
  MASTER_HEADER,
  '1,ZZ901,Test Person,ZZ901,S,M,2,null,01/02/1990,01/01/2026,01/01/2026,,"Flat 1, Test Road",A,MUMBAI,BANDRA,STORE MANAGER',
  // Different casing of the same department/designation; a multi-line quoted address; placeholder DOC; typo email.
  '2,ZZ902,Test Person Two,ZZ902,S,F,2,null,02/03/1995,01/02/2026,01/01/1900,zz902@gamil.com,"Line one,\nLine ""two""",B,Mumbai,Bandra,Store Support staff',
  '3,ZZ903,Test Person Three,ZZ903,F,M,1,null,03/04/1985,01/03/2026,01/03/2026,zz903@example.com,Somewhere,O,MUMBAI,HEAD OFFICE,STORE SUPPORT STAFF',
].join('\r\n');
const LEAVE = [
  'Sr.No.,Employee Code,Employee Name,Leave Type,Opening Balance,Accrued,Leave Used,Current Balance,App Count',
  '1,ZZ901,Test Person,E,19,0,2,17,1',
  '2,ZZ901,Test Person,K,53,0,9,44,9',
  '3,ZZ999,Not In Master,E,10,0,0,10,0',
].join('\n');
const PUNCH = [
  'Sr.No.,Employee Code,Employee Name,Shift,Start Time,IN,Late,Status,Reason',
  '1,ZZ901,Test Person,S,11:00,11:15,00:15,Present,Late',
  '2,ZZ902,Test Person Two,S,11:00,-,-,Absent,Absent',
  '3,ZZ903,Test Person Three,F,05:00,10:35,05:35,Present,Late',
  '4,ZZ999,Not In Master,S,11:00,-,-,Absent,Absent',
].join('\n');

async function teardown(prisma: PrismaService) {
  const users = { user: { organisationId: A.org } };
  await prisma.auditLog.deleteMany({ where: { organisationId: A.org } });
  await prisma.rawPunchEvent.deleteMany({ where: { organisationId: A.org } });
  await prisma.attendanceRecord.deleteMany({ where: { organisationId: A.org } });
  await prisma.leaveBalance.deleteMany({ where: users });
  await prisma.shiftAssignment.deleteMany({ where: { organisationId: A.org } });
  await prisma.shift.deleteMany({ where: { organisationId: A.org } });
  await prisma.payrollPeriodLock.deleteMany({ where: { organisationId: A.org } });
  await prisma.employeeProfile.deleteMany({ where: { organisationId: A.org } });
  await prisma.department.deleteMany({ where: { organisationId: A.org } });
  await prisma.designation.deleteMany({ where: { organisationId: A.org } });
  await prisma.userStore.deleteMany({ where: users });
  await prisma.user.deleteMany({ where: { organisationId: A.org } });
  await prisma.store.deleteMany({ where: { organisationId: A.org } });
  await prisma.organisation.deleteMany({ where: { id: A.org } });
}

describe('EzAttendance import helpers', () => {
  it('parses quoted commas, doubled quotes, newlines and a BOM', () => {
    const rows = parseCsv(String.fromCharCode(0xfeff) + 'a,b\r\n1,"x, ""y""\nz"\r\n\r\n');
    expect(rows).toEqual([{ a: '1', b: 'x, "y"\nz' }]);
  });
  it('title-cases master names but keeps short acronyms', () => {
    expect(titleCase('SENIOR SALES - Stores')).toBe('Senior Sales - Stores');
    expect(titleCase('Operations-HOD')).toBe('Operations-HOD');
    expect(titleCase('HEAD  OFFICE')).toBe('Head Office');
  });
  it('reads DD/MM/YYYY and treats 01/01/1900 as missing', () => {
    expect(parseDmy('05/11/2000')?.toString()).toBe(new Date(Date.UTC(2000, 10, 5)).toString());
    expect(parseDmy('01/01/1900')).toBeNull();
    expect(parseDmy('31/02/2026')).toBe('invalid');
  });
});

describe('Employee master and EzAttendance import (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hoT: string;
  let mgrT: string;
  let repT: string;

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const mapping = () => JSON.stringify({ BANDRA: A.bandra, 'Head Office': null });
  const runImport = (dryRun: boolean, date = '2026-09-18', token = () => hoT) =>
    request(server())
      .post('/hrms/import/ezattendance')
      .set(auth(token()))
      .attach('employees', Buffer.from(MASTER), 'Employee-Master-Full.csv')
      .attach('leaveBalances', Buffer.from(LEAVE), 'Leave-Balance-2026.csv')
      .attach('todaysPunch', Buffer.from(PUNCH), 'Todays-Punch.csv')
      .field('dryRun', dryRun ? '1' : '0')
      .field('departmentStores', mapping())
      .field('attendanceDate', date);
  const profile = (code: string) =>
    prisma.employeeProfile.findFirstOrThrow({
      where: { organisationId: A.org, employeeCode: code },
      include: { user: true, department: true, designation: true },
    });

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService: P } = await import('../src/prisma/prisma.service');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    prisma = app.get(P);
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);
    await prisma.organisation.create({
      data: { id: A.org, name: 'Emp A', slug: A.slug, industryPackCode: 'jewellery' },
    });
    for (const [id, name] of [
      [A.bandra, 'Bandra'],
      [A.andheri, 'Andheri'],
    ]) {
      await prisma.store.create({
        data: { id, name, city: 'Mumbai', organisationId: A.org, timezone: 'Asia/Kolkata' },
      });
    }
    for (const [id, email, role, store] of [
      ['u_emp_ho', A.ho, 'head_office', A.bandra],
      ['u_emp_mgr', A.mgr, 'store_manager', A.bandra],
      ['u_emp_rep', A.rep, 'salesperson', A.bandra],
      ['u_emp_repb', A.repB, 'salesperson', A.andheri],
    ] as const) {
      await prisma.user.create({
        data: {
          id,
          email,
          name: id,
          role: role as never,
          passwordHash: hash,
          isActive: true,
          approvalStatus: 'approved',
          organisationId: A.org,
          userStores: { create: { storeId: store, isPrimary: true } },
        },
      });
    }
    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201)).body
        .token;
    hoT = await login(A.ho);
    mgrT = await login(A.mgr);
    repT = await login(A.rep);
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  it('only head office may import', async () => {
    await runImport(true, '2026-09-18', () => mgrT).expect(403);
  });

  it('a dry run previews everything and writes nothing', async () => {
    const res = await runImport(true).expect(201);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.employees).toMatchObject({ created: 3, updated: 0, unchanged: 0 });
    expect(res.body.departments.created.sort()).toEqual(['Bandra', 'Head Office']);
    expect(res.body.designations.created.sort()).toEqual(['Store Manager', 'Store Support Staff']);
    expect(await prisma.employeeProfile.count({ where: { organisationId: A.org } })).toBe(0);
    expect(await prisma.department.count({ where: { organisationId: A.org } })).toBe(0);
    expect(await prisma.user.count({ where: { organisationId: A.org } })).toBe(4);
  });

  it('apply creates people, masters, balances and attendance', async () => {
    const res = await runImport(false).expect(201);
    const b = res.body;
    expect(b.dryRun).toBe(false);
    expect(b.employees).toMatchObject({ created: 3, updated: 0 });
    expect(b.departments.mapped).toEqual({ Bandra: A.bandra, 'Head Office': null });
    expect(b.leaveBalances.upserted).toBe(2);
    expect(b.leaveBalances.skipped).toEqual([{ code: 'ZZ999', reason: 'not in the employee master' }]);
    expect(b.attendance.upserted).toBe(2);
    expect(b.attendance.skipped.map((s: { code: string }) => s.code).sort()).toEqual(['ZZ903', 'ZZ999']);
    expect(b.exceptions).toEqual(
      expect.arrayContaining([
        { code: 'ZZ902', field: 'Email ID', issue: 'domain looks like a typo' },
        { code: 'ZZ902', field: 'DOC', issue: 'placeholder date 01/01/1900 treated as missing' },
      ]),
    );
    expect(b.notInSource.map((u: { userId: string }) => u.userId).sort()).toEqual([
      'u_emp_mgr',
      'u_emp_rep',
      'u_emp_repb',
    ]);

    const zz1 = await profile('ZZ901');
    expect(zz1.user.role).toBe('store_manager');
    expect(zz1.user.isActive).toBe(false);
    expect(zz1.user.passwordHash).toBeNull();
    expect(zz1.department?.name).toBe('Bandra');
    const zz2 = await profile('ZZ902');
    expect(zz2.departmentId).toBe(zz1.departmentId);
    expect(zz2.user.role).toBe('salesperson');
    expect(zz2.address).toBe('Line one,\nLine "two"');
    expect(zz2.dateOfConfirmation).toBeNull();
    expect(zz2.personalEmail).toBe('zz902@gamil.com');
    expect(await prisma.department.count({ where: { organisationId: A.org } })).toBe(2);

    const shift = await prisma.shift.findFirstOrThrow({ where: { storeId: A.bandra, code: 'S' } });
    expect(shift).toMatchObject({ startTime: '11:00', endTime: '20:00' });
    expect(await prisma.shiftAssignment.count({ where: { userId: zz1.userId, shiftId: shift.id } })).toBe(1);

    const bal = await prisma.leaveBalance.findMany({
      where: { userId: zz1.userId },
      orderBy: { type: 'asc' },
    });
    expect(bal.map((x) => [x.type, x.year, Number(x.allocated), Number(x.used)])).toEqual([
      ['earned', 2026, 19, 2],
      ['week_off_leave', 2026, 53, 9],
    ]);

    const att = await prisma.attendanceRecord.findFirstOrThrow({ where: { staffId: zz1.userId } });
    expect(att).toMatchObject({ status: 'present', isLate: true, lateMinutes: 15, source: 'import' });
    // 11:15 IST.
    expect(att.checkInAt?.toISOString()).toBe('2026-09-18T05:45:00.000Z');
    expect(
      await prisma.rawPunchEvent.count({ where: { userId: zz1.userId, source: 'import', kind: 'in' } }),
    ).toBe(1);
  });

  it('a second run changes nothing', async () => {
    const res = await runImport(false).expect(201);
    expect(res.body.employees).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    expect(res.body.departments.created).toEqual([]);
    expect(res.body.designations.created).toEqual([]);
    expect(res.body.shifts.created).toEqual([]);
    expect(res.body.leaveBalances.upserted).toBe(0);
    expect(res.body.attendance.upserted).toBe(0);
    expect(await prisma.rawPunchEvent.count({ where: { organisationId: A.org } })).toBe(1);
  });

  it('never overwrites attendance recorded in the app', async () => {
    const zz2 = await profile('ZZ902');
    await prisma.attendanceRecord.updateMany({
      where: { staffId: zz2.userId },
      data: { source: 'manager', status: 'present' },
    });
    const res = await runImport(false).expect(201);
    expect(res.body.attendance.skipped).toEqual(
      expect.arrayContaining([{ code: 'ZZ902', reason: 'already recorded in the app (manager)' }]),
    );
    expect((await prisma.attendanceRecord.findFirstOrThrow({ where: { staffId: zz2.userId } })).status).toBe(
      'present',
    );
  });

  it('refuses attendance inside a locked payroll month', async () => {
    await prisma.payrollPeriodLock.create({ data: { organisationId: A.org, month: '2026-08' } });
    const res = await runImport(false, '2026-08-10').expect(201);
    expect(res.body.attendance.upserted).toBe(0);
    expect(res.body.attendance.skipped[0].reason).toBe('Payroll for 2026-08 is locked');
  });

  it('lists staff with and without profiles, scoped by store', async () => {
    const ho = (await request(server()).get('/hrms/employees').set(auth(hoT)).expect(200)).body;
    expect(ho.find((r: { employeeCode: string }) => r.employeeCode === 'ZZ903')).toBeTruthy();
    const rep = ho.find((r: { userId: string }) => r.userId === 'u_emp_rep');
    expect(rep).toMatchObject({ hasProfile: false, status: 'active', employeeCode: null });

    const mgr = (await request(server()).get('/hrms/employees').set(auth(mgrT)).expect(200)).body;
    const codes = mgr.map((r: { employeeCode: string | null }) => r.employeeCode);
    expect(codes).toContain('ZZ902');
    expect(codes).not.toContain('ZZ903'); // no store
    // Only people ranked below a store manager: not their peer, not head office.
    expect(codes).not.toContain('ZZ901');
    const mgrIds = mgr.map((r: { userId: string }) => r.userId);
    expect(mgrIds).not.toContain('u_emp_repb');
    expect(mgrIds).not.toContain('u_emp_ho');
    const zz1 = await profile('ZZ901');
    await request(server()).get(`/hrms/employees/${zz1.userId}`).set(auth(mgrT)).expect(404);

    // Date of birth, blood group and address are head office's alone.
    const mgrRow = mgr.find((r: { employeeCode: string }) => r.employeeCode === 'ZZ902');
    expect(mgrRow).toMatchObject({ dateOfBirth: null, bloodGroup: null, address: null });
    const hoRow = ho.find((r: { employeeCode: string }) => r.employeeCode === 'ZZ902');
    expect(hoRow).toMatchObject({ dateOfBirth: '1995-03-02', bloodGroup: 'B' });

    const filtered = (await request(server()).get('/hrms/employees?q=zz901').set(auth(hoT)).expect(200)).body;
    expect(filtered).toHaveLength(1);
    expect(filtered[0].currentShift).toMatchObject({ startTime: '11:00' });

    await request(server()).get('/hrms/employees').set(auth(repT)).expect(403);
  });

  it('detail carries balances and recent attendance', async () => {
    const zz1 = await profile('ZZ901');
    const d = (await request(server()).get(`/hrms/employees/${zz1.userId}`).set(auth(hoT)).expect(200)).body;
    expect(d.leaveBalances).toHaveLength(2);
    expect(d.recentAttendance[0]).toMatchObject({ date: '2026-09-18', checkIn: '11:15', status: 'present' });
  });

  it('managers edit their staff; role and store changes are head office only', async () => {
    const zz1 = await profile('ZZ901');
    const zz2 = await profile('ZZ902');
    await request(server())
      .patch(`/hrms/employees/${zz2.userId}`)
      .set(auth(mgrT))
      .send({ personalEmail: 'zz902@example.com' })
      .expect(200);
    expect((await profile('ZZ902')).personalEmail).toBe('zz902@example.com');
    await request(server())
      .patch(`/hrms/employees/${zz2.userId}`)
      .set(auth(mgrT))
      .send({ role: 'store_manager' })
      .expect(403);
    // A peer store manager is not theirs to see, let alone edit.
    await request(server())
      .patch(`/hrms/employees/${zz1.userId}`)
      .set(auth(mgrT))
      .send({ unit: 'X' })
      .expect(404);
    await request(server())
      .patch(`/hrms/employees/${zz2.userId}`)
      .set(auth(hoT))
      .send({ storeIds: [A.bandra, A.andheri] })
      .expect(200);
    const audit = await prisma.auditLog.findFirst({
      where: { organisationId: A.org, action: 'employee.update', entityId: zz2.userId },
    });
    expect(audit?.metadata).toHaveProperty('before');
    // Personal columns never reach the audit trail, which store managers can read.
    const trail = JSON.stringify(
      await prisma.auditLog.findMany({ where: { organisationId: A.org, entityId: zz2.userId } }),
    );
    expect(trail).toContain('[redacted]');
    expect(trail).not.toContain('1995-03-02');
    expect(trail).not.toContain('Line one');
  });

  it('creates an inactive employee with a generated login id', async () => {
    const res = await request(server())
      .post('/hrms/employees')
      .set(auth(mgrT))
      .send({
        name: 'Test Person Four',
        role: 'salesperson',
        storeIds: [A.bandra],
        employeeCode: 'ZZ904',
        gender: 'F',
      })
      .expect(201);
    expect(res.body).toMatchObject({ isActive: false, hasProfile: true, employeeCode: 'ZZ904' });
    expect(res.body.loginEmail).toMatch(/^test\.bandra/);
    await request(server())
      .post('/hrms/employees')
      .set(auth(mgrT))
      .send({ name: 'Other', role: 'salesperson', storeIds: [A.bandra], employeeCode: 'ZZ904' })
      .expect(409);
    await request(server())
      .post('/hrms/employees')
      .set(auth(mgrT))
      .send({ name: 'Other', role: 'store_manager', storeIds: [A.bandra], employeeCode: 'ZZ905' })
      .expect(403);
    await request(server())
      .post('/hrms/employees')
      .set(auth(mgrT))
      .send({ name: 'Other', role: 'salesperson', storeIds: [A.andheri], employeeCode: 'ZZ905' })
      .expect(403);
  });

  it('separates, purges only a history-free record, and bulk-activates', async () => {
    const zz2 = await profile('ZZ902');
    const zz4 = await profile('ZZ904');
    const sep = await request(server())
      .delete(`/hrms/employees/${zz2.userId}`)
      .set(auth(mgrT))
      .send({ exitDate: '2026-09-30', exitReason: 'Resigned' })
      .expect(200);
    expect(sep.body).toMatchObject({ status: 'separated', exitDate: '2026-09-30', isActive: false });

    await request(server()).delete(`/hrms/employees/${zz4.userId}?purge=1`).set(auth(mgrT)).expect(403);
    await request(server()).delete(`/hrms/employees/${zz2.userId}?purge=1`).set(auth(hoT)).expect(409);
    await request(server()).delete(`/hrms/employees/${zz4.userId}?purge=1`).set(auth(hoT)).expect(200);
    expect(await prisma.employeeProfile.count({ where: { userId: zz4.userId } })).toBe(0);

    // Bringing back a separated person is head office's call.
    await request(server())
      .patch(`/hrms/employees/${zz2.userId}`)
      .set(auth(mgrT))
      .send({ status: 'active' })
      .expect(403);
    const refused = await request(server())
      .post('/hrms/employees/bulk')
      .set(auth(mgrT))
      .send({ userIds: [zz2.userId], action: 'activate' })
      .expect(201);
    expect(refused.body.done).toEqual([]);
    expect(refused.body.failed[0].userId).toBe(zz2.userId);

    const bulk = await request(server())
      .post('/hrms/employees/bulk')
      .set(auth(hoT))
      .send({ userIds: [zz2.userId], action: 'activate' })
      .expect(201);
    expect(bulk.body.done).toEqual([zz2.userId]);
    const after = await profile('ZZ902');
    expect(after).toMatchObject({ status: 'active', exitDate: null });
    expect(after.user.isActive).toBe(true);
  });

  it('department and designation masters', async () => {
    const list = (await request(server()).get('/hrms/departments').set(auth(mgrT)).expect(200)).body;
    const bandra = list.find((d: { name: string }) => d.name === 'Bandra');
    expect(bandra).toMatchObject({ storeName: 'Bandra', employeeCount: 2 });

    await request(server()).post('/hrms/departments').set(auth(mgrT)).send({ name: 'Andheri' }).expect(403);
    const andheri = (
      await request(server())
        .post('/hrms/departments')
        .set(auth(hoT))
        .send({ name: 'Andheri', storeId: A.andheri })
        .expect(201)
    ).body;
    await request(server()).post('/hrms/departments').set(auth(hoT)).send({ name: 'Andheri' }).expect(409);
    await request(server()).delete(`/hrms/departments/${bandra.id}`).set(auth(hoT)).expect(409);
    await request(server())
      .delete(`/hrms/departments/${bandra.id}?reassignTo=${andheri.id}`)
      .set(auth(hoT))
      .expect(200);
    expect((await profile('ZZ901')).departmentId).toBe(andheri.id);

    const des = (await request(server()).get('/hrms/designations').set(auth(hoT)).expect(200)).body;
    expect(des.map((d: { name: string }) => d.name).sort()).toEqual(['Store Manager', 'Store Support Staff']);
    const renamed = await request(server())
      .patch(`/hrms/designations/${des[0].id}`)
      .set(auth(hoT))
      .send({ name: 'Renamed' })
      .expect(200);
    expect(renamed.body.name).toBe('Renamed');
  });
});
