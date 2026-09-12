import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { Workbook } from 'exceljs';

/**
 * The lead export.
 *
 * A file of customer names and phone numbers leaving the system is a different
 * act from reading one lead on a screen, so the properties pinned here are the
 * ones that decide whether that act is safe:
 *
 *  1. IT IS A REAL XLSX. Not CSV with an .xlsx name — that opens with a security
 *     warning and loses every date and number type. Asserted by reading the
 *     bytes back with a spreadsheet parser, not by trusting the header.
 *
 *  2. SCOPE COMES FROM THE TOKEN. A storeId in the query can narrow the result;
 *     it can never widen it. A manager scoped to one branch exporting with
 *     another branch's id must not receive that branch's customers.
 *
 *  3. A TENANT SEES ONLY ITSELF. No filter combination reaches another
 *     organisation's leads.
 *
 *  4. IT IS AUDITED. The trail records what was asked for — not the rows, which
 *     would put the same personal data in a second place.
 *
 *  5. NOTHING IS SILENTLY TRUNCATED. The count endpoint answers before the file
 *     is built, and an over-limit request is refused with the real number rather
 *     than returning a short file nobody can tell is short.
 *
 *  6. A SALESPERSON CANNOT DO IT AT ALL.
 */

const PASSWORD = 'password123';

const A = {
  org: 'org_exp_a', slug: 'exp-a',
  storeMain: 'store_exp_a_main', storeOther: 'store_exp_a_other',
  ho: 'ho.exp@exp-a.local', mgr: 'mgr.exp@exp-a.local', rep: 'rep.exp@exp-a.local',
};
const B = { org: 'org_exp_b', slug: 'exp-b', store: 'store_exp_b', ho: 'ho.exp@exp-b.local' };

async function teardown(prisma: import('../src/prisma/prisma.service').PrismaService) {
  const orgs = [A.org, B.org];
  await prisma.leadTagAssignment.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.leadTag.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.auditLog.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.activityEvent.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.leadFollowUp.deleteMany({ where: { lead: { organisationId: { in: orgs } } } });
  await prisma.lead.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: { in: orgs } } } });
  await prisma.user.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.store.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.organisation.deleteMany({ where: { id: { in: orgs } } });
}

describe('Lead export (e2e)', () => {
  let app: INestApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  let hoA: string;
  let mgrA: string;
  let repA: string;
  let hoB: string;

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService } = await import('../src/prisma/prisma.service');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true, forbidNonWhitelisted: true, transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);

    await prisma.organisation.create({
      data: { id: A.org, name: 'Exp A', slug: A.slug, industryPackCode: 'retail' },
    });
    await prisma.store.createMany({
      data: [
        { id: A.storeMain, name: 'Main', city: 'Mumbai', organisationId: A.org, timezone: 'Asia/Kolkata' },
        { id: A.storeOther, name: 'Other', city: 'Surat', organisationId: A.org, timezone: 'Asia/Kolkata' },
      ],
    });
    const mkUser = async (id: string, email: string, role: string, storeId: string) =>
      prisma.user.create({
        data: {
          id, email, name: id, role: role as never, passwordHash: hash, isActive: true,
          approvalStatus: 'approved', organisationId: A.org,
          userStores: { create: { storeId, isPrimary: true } },
        },
      });
    await mkUser('u_exp_a_ho', A.ho, 'head_office', A.storeMain);
    // Scoped to ONE branch: property 2 depends on it.
    await mkUser('u_exp_a_mgr', A.mgr, 'store_manager', A.storeMain);
    await mkUser('u_exp_a_rep', A.rep, 'salesperson', A.storeMain);

    await prisma.organisation.create({
      data: { id: B.org, name: 'Exp B', slug: B.slug, industryPackCode: 'retail' },
    });
    await prisma.store.create({
      data: { id: B.store, name: 'B Store', city: 'Pune', organisationId: B.org, timezone: 'Asia/Kolkata' },
    });
    await prisma.user.create({
      data: {
        id: 'u_exp_b_ho', email: B.ho, name: 'Exp B HO', role: 'head_office',
        passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: B.org,
        userStores: { create: { storeId: B.store, isPrimary: true } },
      },
    });

    await prisma.lead.createMany({
      data: [
        { id: 'lx_main_1', organisationId: A.org, storeId: A.storeMain, ref: 'LD-EX-1', customerName: 'Main Customer One', phone: '919812300001', source: 'walk_in', stage: 'inquiry' },
        { id: 'lx_main_2', organisationId: A.org, storeId: A.storeMain, ref: 'LD-EX-2', customerName: 'Main Customer Two', phone: '919812300002', source: 'meta_ads', stage: 'inquiry' },
        { id: 'lx_other_1', organisationId: A.org, storeId: A.storeOther, ref: 'LD-EX-3', customerName: 'Other Branch Customer', phone: '919812300003', source: 'walk_in', stage: 'inquiry' },
        { id: 'lx_b_1', organisationId: B.org, storeId: B.store, ref: 'LD-EX-4', customerName: 'Rival Tenant Customer', phone: '919812300004', source: 'walk_in', stage: 'inquiry' },
      ],
    });

    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201))
        .body.token;
    hoA = await login(A.ho);
    mgrA = await login(A.mgr);
    repA = await login(A.rep);
    hoB = await login(B.ho);
  }, 120_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  /**
   * Fetch the workbook as raw bytes.
   *
   * supertest defaults to a text parser, which mangles a ZIP container into
   * something JSZip cannot open — so the binary parser is explicit here. Without
   * it the assertion "is this a real XLSX" fails for the wrong reason.
   */
  const getXlsx = (token: string, qs = '') =>
    request(server())
      .get(`/crm/exports/leads.xlsx${qs}`)
      .set(auth(token))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

  /** Read the returned bytes with a real spreadsheet parser. */
  const readBack = async (body: Buffer) => {
    const wb = new Workbook();
    await wb.xlsx.load(body as never);
    const ws = wb.worksheets[0];
    const rows: string[][] = [];
    ws.eachRow((row) => {
      rows.push((row.values as unknown[]).slice(1).map((v) => (v == null ? '' : String(v))));
    });
    return { sheetName: ws.name, rows };
  };

  it('returns a genuine XLSX, not CSV wearing an .xlsx name', async () => {
    const res = await getXlsx(hoA).expect(200);

    // ZIP local-file-header magic. A CSV would start with the first column name.
    expect(res.body.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toContain('.xlsx');

    const { sheetName, rows } = await readBack(res.body);
    expect(sheetName).toBe('Leads');
    expect(rows[0]).toContain('Customer');
    expect(rows[0]).toContain('Phone');
    // Head office sees both of its own branches, and nobody else's.
    const names = rows.slice(1).map((r) => r[0]);
    expect(names).toEqual(
      expect.arrayContaining(['Main Customer One', 'Main Customer Two', 'Other Branch Customer']),
    );
    expect(names).not.toContain('Rival Tenant Customer');
  });

  it('a branch-scoped manager gets only their branch', async () => {
    const res = await getXlsx(mgrA).expect(200);
    const { rows } = await readBack(res.body);
    const names = rows.slice(1).map((r) => r[0]);
    expect(names).toEqual(
      expect.arrayContaining(['Main Customer One', 'Main Customer Two']),
    );
    expect(names).not.toContain('Other Branch Customer');
  });

  it('asking for another branch by id does not widen the scope', async () => {
    const res = await getXlsx(mgrA, `?storeId=${A.storeOther}`);

    // Either refused outright, or narrowed to nothing — never the other branch.
    if (res.status === 200) {
      const { rows } = await readBack(res.body);
      expect(rows.slice(1).map((r) => r[0])).not.toContain('Other Branch Customer');
    } else {
      expect([403, 404]).toContain(res.status);
    }
  });

  it('a salesperson cannot export at all', async () => {
    await request(server()).get('/crm/exports/leads.xlsx').set(auth(repA)).expect(403);
    await request(server()).get('/crm/exports/leads/count').set(auth(repA)).expect(403);
  });

  it('the count is answered before the file is built', async () => {
    const mine = await request(server()).get('/crm/exports/leads/count').set(auth(hoA)).expect(200);
    expect(mine.body.rows).toBe(3);
    const theirs = await request(server()).get('/crm/exports/leads/count').set(auth(hoB)).expect(200);
    expect(theirs.body.rows).toBe(1);
  });

  it('filters narrow the file, and a tag filter works', async () => {
    const tag = await request(server())
      .post('/lead-tags').set(auth(hoA)).send({ name: 'Export Tagged' }).expect(201);
    await request(server())
      .put('/lead-tags/lead/lx_main_2').set(auth(hoA)).send({ tagIds: [tag.body.id] }).expect(200);

    const res = await getXlsx(hoA, `?tagIds=${tag.body.id}`).expect(200);
    const { rows } = await readBack(res.body);
    expect(rows).toHaveLength(2); // header + the one tagged lead
    expect(rows[1][0]).toBe('Main Customer Two');

    const bySource = await request(server())
      .get('/crm/exports/leads/count?source=meta_ads').set(auth(hoA)).expect(200);
    expect(bySource.body.rows).toBe(1);
  });

  it('an unknown column name is refused rather than silently blank', async () => {
    await request(server())
      .get('/crm/exports/leads.xlsx?columns=customerName,notAColumn')
      .set(auth(hoA))
      .expect(400);
  });

  it('every export writes an audit row describing what was asked for', async () => {
    const before = await prisma.auditLog.count({
      where: { organisationId: A.org, action: 'crm.leads.exported' },
    });
    await getXlsx(hoA, '?source=walk_in').expect(200);
    const rows = await prisma.auditLog.findMany({
      where: { organisationId: A.org, action: 'crm.leads.exported' },
      orderBy: { createdAt: 'desc' },
    });
    expect(rows.length).toBe(before + 1);
    const meta = rows[0].metadata as Record<string, unknown>;
    expect((meta.filters as Record<string, unknown>).source).toBe('walk_in');
    // The trail says how many rows left, but never carries the rows themselves.
    expect(typeof meta.rows).toBe('number');
    expect(JSON.stringify(meta)).not.toContain('919812300001');
  });
});
