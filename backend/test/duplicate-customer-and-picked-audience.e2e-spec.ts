import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { roleDefaults } from '../src/auth/access';
import { compileSegment, parseSegmentDefinition } from '../src/crm/audience-segment.dsl';

/**
 * ONE PERSON, TWO SHOPS — and an audience chosen by hand.
 *
 * Three things that a multi-store jeweller gets wrong by default:
 *
 *  1. The same customer walks into Bandra and then Andheri. Before this,
 *     `POST /parties` wrote a second record with no check of any kind, and
 *     nothing anywhere said so. Two histories, two intent scores, two rows in
 *     an export, two of them in any "not seen for 90 days" campaign.
 *
 *  2. Only marketing and head office could reach the bulk-send screen, so the
 *     person who actually knows which customers have stopped coming had to ask
 *     somebody else to message them.
 *
 *  3. An audience could only be a RULE. A manager with five particular people
 *     in mind had no way to express that.
 */
const PASSWORD = 'password123';

const ORG = 'org_dupe';
const BANDRA = 'store_dupe_bandra';
const ANDHERI = 'store_dupe_andheri';
const HO = 'ho.dupe@dupe.local';
const MGR_BANDRA = 'bandra.dupe@dupe.local';
const MGR_ANDHERI = 'andheri.dupe@dupe.local';

const SHARED_PHONE = '9876500011';

describe('duplicate customers across stores, and hand-picked audiences (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens: Record<string, string> = {};

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const login = async (email: string) => {
    const r = await request(server()).post('/auth/login').send({ email, password: PASSWORD });
    expect(r.status).toBe(201);
    return r.body.token as string;
  };

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
      data: { id: ORG, name: 'Dupe Jewels', slug: 'dupe', industryPackCode: 'jewellery' },
    });
    // Two branches in ONE city, which is the case the client described.
    await prisma.store.createMany({
      data: [
        { id: BANDRA, name: 'Mumbai - Bandra', city: 'Mumbai', organisationId: ORG },
        { id: ANDHERI, name: 'Mumbai - Andheri', city: 'Mumbai', organisationId: ORG },
      ],
    });
    await prisma.user.create({
      data: {
        email: HO, name: 'Head Office', role: 'head_office', passwordHash: hash,
        isActive: true, approvalStatus: 'approved', organisationId: ORG,
        userStores: { create: { storeId: BANDRA, isPrimary: true } },
      },
    });
    await prisma.user.create({
      data: {
        email: MGR_BANDRA, name: 'Bandra Manager', role: 'store_manager', passwordHash: hash,
        isActive: true, approvalStatus: 'approved', organisationId: ORG,
        userStores: { create: { storeId: BANDRA, isPrimary: true } },
      },
    });
    await prisma.user.create({
      data: {
        email: MGR_ANDHERI, name: 'Andheri Manager', role: 'store_manager', passwordHash: hash,
        isActive: true, approvalStatus: 'approved', organisationId: ORG,
        userStores: { create: { storeId: ANDHERI, isPrimary: true } },
      },
    });

    tokens.ho = await login(HO);
    tokens.bandra = await login(MGR_BANDRA);
    tokens.andheri = await login(MGR_ANDHERI);
  }, 180_000);

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  /* ------------------------------------------------ one person, two shops */

  it('accepts the customer at the first branch that enters them', async () => {
    const res = await request(server())
      .post('/parties')
      .set(auth(tokens.bandra))
      .send({ name: 'Priya Sharma', phone: SHARED_PHONE, storeId: BANDRA, city: 'Mumbai' })
      .expect(201);

    expect(res.body.name).toBe('Priya Sharma');
    expect(res.body.phone).toBe(SHARED_PHONE);
  });

  it('refuses the second branch, and NAMES the branch that holds them', async () => {
    const res = await request(server())
      .post('/parties')
      .set(auth(tokens.andheri))
      .send({ name: 'Priya S', phone: SHARED_PHONE, storeId: ANDHERI, city: 'Mumbai' })
      .expect(409);

    // Naming the branch is the whole point. "This customer already exists"
    // leaves a manager with nothing to do; naming Bandra tells them who to ask.
    expect(res.body.message).toContain('Mumbai - Bandra');
    expect(res.body.message).toMatch(/reassign/i);

    // And nothing was written.
    const count = await prisma.party.count({
      where: { organisationId: ORG, phone: SHARED_PHONE },
    });
    expect(count).toBe(1);
  });

  it('looks across the WHOLE tenant, not just the branches the caller can see', async () => {
    // The Andheri manager cannot see Bandra's customers at all. A duplicate
    // check scoped to what they can see would have reported "no duplicate" and
    // created the second record, which is exactly the bug.
    const visible = await request(server())
      .get('/parties?type=customer')
      .set(auth(tokens.andheri))
      .expect(200);
    const rows: Array<{ phone?: string }> = Array.isArray(visible.body)
      ? visible.body
      : (visible.body.items ?? []);
    expect(rows.map((r) => r.phone)).not.toContain(SHARED_PHONE);
  });

  it('refuses a second record at the SAME branch too, with different advice', async () => {
    const res = await request(server())
      .post('/parties')
      .set(auth(tokens.bandra))
      .send({ name: 'Priya Sharma', phone: SHARED_PHONE, storeId: BANDRA })
      .expect(409);

    expect(res.body.message).toMatch(/open their record/i);
    // No reassignment advice here: it is already their customer.
    expect(res.body.message).not.toMatch(/ask head office to reassign/i);
  });

  it('counts an archived contact as taken, so an opt-out cannot be typed over', async () => {
    const other = await prisma.party.create({
      data: {
        organisationId: ORG,
        storeId: BANDRA,
        name: 'Rohan Archived',
        phone: '9876500022',
        types: ['customer'],
        archivedAt: new Date(),
      },
    });

    const res = await request(server())
      .post('/parties')
      .set(auth(tokens.andheri))
      .send({ name: 'Rohan', phone: '9876500022', storeId: ANDHERI })
      .expect(409);

    expect(res.body.message).toMatch(/archived/i);
    expect(res.body.message).toMatch(/restore/i);

    await prisma.party.delete({ where: { id: other.id } });
  });

  it('lets a different number through, so the guard is not just refusing everything', async () => {
    await request(server())
      .post('/parties')
      .set(auth(tokens.andheri))
      .send({ name: 'Ananya Iyer', phone: '9876500033', storeId: ANDHERI })
      .expect(201);
  });

  /* ------------------------------------------- bulk send, for a manager */

  it('gives a store manager the bulk-send screen, at STORE level', async () => {
    // The level is what makes it safe, not the absence of the screen: at
    // 'store' their audience cannot reach past the branches they run.
    //
    // Read through `roleDefaults` rather than the map directly: a tenant can
    // start its sales staff on attendance only, and the defaults differ there.
    expect(roleDefaults('store_manager', ORG)['campaigns']).toBe('store');
    // A salesperson is still not given it.
    expect(roleDefaults('salesperson', ORG)['campaigns']).toBeUndefined();
  });

  it('lets a store manager open the campaign list', async () => {
    await request(server()).get('/campaigns').set(auth(tokens.bandra)).expect(200);
  });

  /* ------------------------------------- an audience chosen by hand */

  it('compiles a hand-picked list of customers into an audience', () => {
    const definition = parseSegmentDefinition({
      match: 'all',
      conditions: [{ field: 'party.id', op: 'in', value: ['p1', 'p2', 'p3'] }],
    });
    const compiled = compileSegment(definition, new Date());

    expect(JSON.stringify(compiled.where)).toContain('p2');
    expect(compiled.reasons.join(' ')).toMatch(/chosen by hand/i);
  });

  it('previews a hand-picked audience with a real count before anything is sent', async () => {
    const picked = await prisma.party.findMany({
      where: { organisationId: ORG, types: { has: 'customer' }, archivedAt: null },
      select: { id: true },
      take: 2,
    });
    expect(picked.length).toBeGreaterThan(0);

    const res = await request(server())
      .post('/audiences/preview')
      .set(auth(tokens.ho))
      .send({
        definition: {
          match: 'all',
          conditions: [{ field: 'party.id', op: 'in', value: picked.map((p) => p.id) }],
        },
      })
      .expect(201);

    // The count is a database aggregate, not the length of the sample rows.
    expect(res.body.total).toBe(picked.length);
  });

  it('excludes a hand-picked customer who is not one of the chosen', async () => {
    const all = await prisma.party.findMany({
      where: { organisationId: ORG, types: { has: 'customer' }, archivedAt: null },
      select: { id: true },
    });
    expect(all.length).toBeGreaterThan(1);

    const res = await request(server())
      .post('/audiences/preview')
      .set(auth(tokens.ho))
      .send({
        definition: {
          match: 'all',
          conditions: [{ field: 'party.id', op: 'in', value: [all[0].id] }],
        },
      })
      .expect(201);

    expect(res.body.total).toBe(1);
  });
});

async function teardown(prisma: PrismaService) {
  await prisma.campaignRecipient.deleteMany({ where: { organisationId: ORG } });
  await prisma.messagingCampaign.deleteMany({ where: { organisationId: ORG } });
  await prisma.audienceSegment.deleteMany({ where: { organisationId: ORG } });
  await prisma.contactPoint.deleteMany({ where: { organisationId: ORG } });
  await prisma.lead.deleteMany({ where: { organisationId: ORG } });
  await prisma.party.deleteMany({ where: { organisationId: ORG } });
  await prisma.userStore.deleteMany({ where: { storeId: { in: [BANDRA, ANDHERI] } } });
  await prisma.user.deleteMany({ where: { organisationId: ORG } });
  await prisma.store.deleteMany({ where: { organisationId: ORG } });
  await prisma.organisation.deleteMany({ where: { id: ORG } });
}
