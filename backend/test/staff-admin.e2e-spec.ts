import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * The 9 Oct staff-administration round, end to end:
 *  - edit a person's details in place (name/Login ID/phone), uniqueness held;
 *  - delete only an account with no operational history, others are refused
 *    by name and pointed at Deactivate;
 *  - custom roles: create (head office only), apply (base role + screens in
 *    one stamp), re-save screens, delete without stripping anyone;
 *  - customer tags on a Party, same vocabulary as leads;
 *  - customer delete only with no history, Gati-synced rows always refused.
 */
const PASSWORD = 'password123';
const A = {
  org: 'org_sadmin',
  slug: 'sadmin',
  store: 'store_sadmin',
  ho: 'ho.sadmin@sadmin.local',
  mgr: 'mgr.sadmin@sadmin.local',
  rep: 'rep.sadmin@sadmin.local',
};

async function teardown(prisma: PrismaService) {
  await prisma.partyTagAssignment.deleteMany({ where: { organisationId: A.org } });
  await prisma.leadTag.deleteMany({ where: { organisationId: A.org } });
  await prisma.customRole.deleteMany({ where: { organisationId: A.org } });
  await prisma.attendanceRecord.deleteMany({ where: { organisationId: A.org } });
  await prisma.party.deleteMany({ where: { organisationId: A.org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: A.org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: A.org } } });
  await prisma.user.deleteMany({ where: { organisationId: A.org } });
  await prisma.store.deleteMany({ where: { organisationId: A.org } });
  await prisma.organisation.deleteMany({ where: { id: A.org } });
}

describe('Staff administration and customer records (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hoT = '';
  let mgrT = '';

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);
    await prisma.organisation.create({
      data: { id: A.org, name: 'SAdmin Jewels', slug: A.slug, industryPackCode: 'jewellery' },
    });
    await prisma.store.create({
      data: { id: A.store, name: 'Main', city: 'Mumbai', organisationId: A.org },
    });
    for (const [id, email, role] of [
      ['u_sadmin_ho', A.ho, 'head_office'],
      ['u_sadmin_mgr', A.mgr, 'store_manager'],
      ['u_sadmin_rep', A.rep, 'salesperson'],
    ] as const) {
      await prisma.user.create({
        data: {
          id, email, name: id, role: role as never, passwordHash: hash, isActive: true,
          approvalStatus: 'approved', organisationId: A.org,
          userStores: { create: { storeId: A.store, isPrimary: true } },
        },
      });
    }
    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201))
        .body.token as string;
    hoT = await login(A.ho);
    mgrT = await login(A.mgr);
  }, 120_000);

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  /* ------------------------------------------------------ staff edit/delete */

  it('a manager fixes a name, Login ID and phone in place', async () => {
    const res = await request(server())
      .patch('/users/u_sadmin_rep')
      .set(auth(mgrT))
      .send({ name: 'Priya Mehta', email: 'priya.mehta@sadmin.local', phone: '9898989898' })
      .expect(200);
    expect(res.body.name).toBe('Priya Mehta');
    expect(res.body.email).toBe('priya.mehta@sadmin.local');

    // A taken Login ID is refused in words, not a 500.
    const clash = await request(server())
      .patch('/users/u_sadmin_rep')
      .set(auth(mgrT))
      .send({ email: A.mgr });
    expect(clash.status).toBe(400);
    expect(JSON.stringify(clash.body)).toMatch(/already taken/i);
  });

  it('delete refuses anyone with history and names what they hold', async () => {
    await prisma.attendanceRecord.create({
      data: {
        organisationId: A.org, storeId: A.store, staffId: 'u_sadmin_rep',
        date: new Date('2026-10-01'), status: 'present' as never,
      },
    });
    const refused = await request(server())
      .delete('/users/u_sadmin_rep')
      .set(auth(hoT));
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/attendance.*Deactivate/is);

    // A history-free account (the typo/duplicate case) deletes whole.
    await prisma.user.create({
      data: {
        id: 'u_sadmin_typo', email: 'typo@sadmin.local', name: 'Typo', role: 'salesperson' as never,
        passwordHash: 'x', isActive: true, approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.store, isPrimary: true } },
      },
    });
    await request(server()).delete('/users/u_sadmin_typo').set(auth(hoT)).expect(200);
    expect(await prisma.user.findUnique({ where: { id: 'u_sadmin_typo' } })).toBeNull();
  });

  /* ------------------------------------------------------------ custom roles */

  it('head office creates a role; a manager cannot', async () => {
    await request(server())
      .post('/users/roles')
      .set(auth(mgrT))
      .send({ name: 'Floor Lead', baseRole: 'salesperson' })
      .expect(403);

    const created = await request(server())
      .post('/users/roles')
      .set(auth(hoT))
      .send({
        name: 'Floor Lead',
        baseRole: 'salesperson',
        overrides: { quotation: 'store' },
      })
      .expect(201);
    expect(created.body.name).toBe('Floor Lead');

    const dup = await request(server())
      .post('/users/roles')
      .set(auth(hoT))
      .send({ name: 'Floor Lead', baseRole: 'salesperson' });
    expect(dup.status).toBe(400);
  });

  it('applying a role stamps base role + screens, and shows on the person', async () => {
    const roles = await request(server()).get('/users/roles').set(auth(mgrT)).expect(200);
    const role = roles.body.find((r: { name: string }) => r.name === 'Floor Lead');

    await request(server())
      .post('/users/u_sadmin_rep/apply-role')
      .set(auth(hoT))
      .send({ roleId: role.id })
      .expect(201);

    const u = await prisma.user.findUniqueOrThrow({ where: { id: 'u_sadmin_rep' } });
    expect(u.role).toBe('salesperson');
    expect(u.customRoleName).toBe('Floor Lead');
    expect((u.accessOverrides as Record<string, string>).quotation).toBe('store');
  });

  it('deleting the template strips nobody', async () => {
    const roles = await request(server()).get('/users/roles').set(auth(hoT)).expect(200);
    const role = roles.body.find((r: { name: string }) => r.name === 'Floor Lead');
    await request(server()).delete(`/users/roles/${role.id}`).set(auth(hoT)).expect(200);

    const u = await prisma.user.findUniqueOrThrow({ where: { id: 'u_sadmin_rep' } });
    // The stamp holds: access was copied, not referenced.
    expect((u.accessOverrides as Record<string, string>).quotation).toBe('store');
  });

  /* ------------------------------------------------- customer tags + delete */

  it('a customer wears the same tag vocabulary as leads', async () => {
    const tag = await request(server())
      .post('/lead-tags')
      .set(auth(mgrT))
      .send({ name: 'VIP' })
      .expect(201);
    const party = await prisma.party.create({
      data: { organisationId: A.org, storeId: A.store, name: 'Tag Customer', types: ['customer'] },
    });

    const set = await request(server())
      .put(`/lead-tags/party/${party.id}`)
      .set(auth(mgrT))
      .send({ tagIds: [tag.body.id] })
      .expect(200);
    expect(set.body.map((t: { name: string }) => t.name)).toEqual(['VIP']);
  });

  it('customer delete: history refuses, Gati rows refuse, a bare row deletes', async () => {
    const withSale = await prisma.party.create({
      data: { organisationId: A.org, storeId: A.store, name: 'Has History', types: ['customer'] },
    });
    await prisma.sale.create({
      data: {
        organisationId: A.org, storeId: A.store, partyId: withSale.id,
        docType: 'sale' as never, docNo: 'S-1', docDate: new Date(), totalAmount: 1000,
      },
    });
    const refused = await request(server()).delete(`/parties/${withSale.id}`).set(auth(hoT));
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/sales.*Archive/is);

    const synced = await prisma.party.create({
      data: { organisationId: A.org, storeId: A.store, name: 'From Gati', types: ['customer'], legacyId: 'G-77' },
    });
    const gati = await request(server()).delete(`/parties/${synced.id}`).set(auth(hoT));
    expect(gati.status).toBe(400);
    expect(JSON.stringify(gati.body)).toMatch(/Gati/i);

    const bare = await prisma.party.create({
      data: { organisationId: A.org, storeId: A.store, name: 'Mistake Row', types: ['customer'] },
    });
    await request(server()).delete(`/parties/${bare.id}`).set(auth(hoT)).expect(200);
    expect(await prisma.party.findUnique({ where: { id: bare.id } })).toBeNull();

    await prisma.sale.deleteMany({ where: { organisationId: A.org } });
  });
});
