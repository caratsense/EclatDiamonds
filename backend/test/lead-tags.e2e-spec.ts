import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

/**
 * Tenant-defined labels on a lead.
 *
 * The properties pinned here are the ones that would each be a real incident:
 *
 *  1. A TAG BELONGS TO ONE TENANT. Tenant B cannot list, rename, retire or apply
 *     tenant A's tags, and asking for one reads as "not found" rather than
 *     "forbidden" — the second answer confirms the row exists.
 *
 *  2. A LEAD BELONGS TO ONE STORE. A salesperson scoped to one branch cannot
 *     label another branch's lead, even inside their own organisation.
 *
 *  3. THE SAME NAME TWICE IS THE SAME TAG. Case and spacing must not be able to
 *     produce "Potential Lead", "potential lead" and "Potential  Lead" side by
 *     side, because a filter built on one silently misses the others.
 *
 *  4. SETTING IS A SET, NOT AN APPEND. Sending the same body twice leaves the
 *     lead in the same state; sending a shorter list removes what is missing.
 *
 *  5. RETIRING KEEPS THE HISTORY. A tag taken out of the picker stays on the
 *     leads that already carried it, because it records what somebody thought at
 *     the time.
 *
 *  6. CHANGING THE VOCABULARY IS A MANAGER'S JOB. A salesperson may label a
 *     lead; renaming a tag underneath a whole team is not theirs to do.
 */

const PASSWORD = 'password123';

const A = {
  org: 'org_tag_a',
  slug: 'tag-a',
  storeMain: 'store_tag_a_main',
  storeOther: 'store_tag_a_other',
  ho: 'ho.tag@tag-a.local',
  rep: 'rep.tag@tag-a.local',
};
const B = {
  org: 'org_tag_b',
  slug: 'tag-b',
  store: 'store_tag_b',
  ho: 'ho.tag@tag-b.local',
};

async function teardown(prisma: import('../src/prisma/prisma.service').PrismaService) {
  const orgs = [A.org, B.org];
  await prisma.leadTagAssignment.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.leadTag.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.activityEvent.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.leadFollowUp.deleteMany({ where: { lead: { organisationId: { in: orgs } } } });
  await prisma.lead.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: { in: orgs } } } });
  await prisma.user.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.store.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.organisation.deleteMany({ where: { id: { in: orgs } } });
}

describe('Lead tags (e2e)', () => {
  let app: INestApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  let hoA: string;
  let repA: string;
  let hoB: string;
  let leadMain: string;
  let leadOther: string;
  let leadB: string;

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService } = await import('../src/prisma/prisma.service');
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
    prisma = app.get(PrismaService);
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);

    await prisma.organisation.create({
      data: { id: A.org, name: 'Tag A', slug: A.slug, industryPackCode: 'retail' },
    });
    await prisma.store.createMany({
      data: [
        { id: A.storeMain, name: 'Main', city: 'Mumbai', organisationId: A.org, timezone: 'Asia/Kolkata' },
        { id: A.storeOther, name: 'Other', city: 'Surat', organisationId: A.org, timezone: 'Asia/Kolkata' },
      ],
    });
    await prisma.user.create({
      data: {
        id: 'u_tag_a_ho', email: A.ho, name: 'Tag A HO', role: 'head_office',
        passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.storeMain, isPrimary: true } },
      },
    });
    // Scoped to ONE branch on purpose: property 2 depends on it.
    await prisma.user.create({
      data: {
        id: 'u_tag_a_rep', email: A.rep, name: 'Tag A Rep', role: 'salesperson',
        passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.storeMain, isPrimary: true } },
      },
    });

    await prisma.organisation.create({
      data: { id: B.org, name: 'Tag B', slug: B.slug, industryPackCode: 'retail' },
    });
    await prisma.store.create({
      data: { id: B.store, name: 'B Store', city: 'Pune', organisationId: B.org, timezone: 'Asia/Kolkata' },
    });
    await prisma.user.create({
      data: {
        id: 'u_tag_b_ho', email: B.ho, name: 'Tag B HO', role: 'head_office',
        passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: B.org,
        userStores: { create: { storeId: B.store, isPrimary: true } },
      },
    });

    const mkLead = async (id: string, org: string, storeId: string, ref: string, ownerId?: string) => {
      await prisma.lead.create({
        data: {
          id, organisationId: org, storeId, ref, ownerId,
          customerName: 'Test Customer', source: 'walk_in', stage: 'inquiry',
        },
      });
      return id;
    };
    // The rep's own lead: a salesperson labels the leads they work, not a colleague's.
    leadMain = await mkLead('lead_tag_main', A.org, A.storeMain, 'LD-TAG-1', 'u_tag_a_rep');
    leadOther = await mkLead('lead_tag_other', A.org, A.storeOther, 'LD-TAG-2');
    leadB = await mkLead('lead_tag_b', B.org, B.store, 'LD-TAG-3');

    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201))
        .body.token;
    hoA = await login(A.ho);
    repA = await login(A.rep);
    hoB = await login(B.ho);
  }, 120_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  /* ------------------------------------------------------ the vocabulary */

  let potentialId: string;

  it('a manager creates a tag', async () => {
    const res = await request(server())
      .post('/lead-tags')
      .set(auth(hoA))
      .send({ name: 'Potential Lead', colour: 'amber' })
      .expect(201);
    expect(res.body.name).toBe('Potential Lead');
    expect(res.body.isActive).toBe(true);
    expect(res.body.leadCount).toBe(0);
    potentialId = res.body.id;
  });

  it('the same name in different case or spacing is refused as a duplicate', async () => {
    for (const name of ['potential lead', 'POTENTIAL LEAD', 'Potential  Lead']) {
      await request(server()).post('/lead-tags').set(auth(hoA)).send({ name }).expect(409);
    }
  });

  it('another tenant may use the same name, and cannot see ours', async () => {
    await request(server())
      .post('/lead-tags')
      .set(auth(hoB))
      .send({ name: 'Potential Lead' })
      .expect(201);

    const ours = await request(server()).get('/lead-tags').set(auth(hoA)).expect(200);
    const theirs = await request(server()).get('/lead-tags').set(auth(hoB)).expect(200);
    expect(ours.body).toHaveLength(1);
    expect(theirs.body).toHaveLength(1);
    expect(ours.body[0].id).not.toBe(theirs.body[0].id);
  });

  it("another tenant's tag reads as not found, not forbidden", async () => {
    await request(server())
      .patch(`/lead-tags/${potentialId}`)
      .set(auth(hoB))
      .send({ name: 'Stolen' })
      .expect(404);
    await request(server()).delete(`/lead-tags/${potentialId}`).set(auth(hoB)).expect(404);
  });

  it('a salesperson may read the vocabulary but not change it', async () => {
    await request(server()).get('/lead-tags').set(auth(repA)).expect(200);
    await request(server())
      .post('/lead-tags')
      .set(auth(repA))
      .send({ name: 'Rep Invented This' })
      .expect(403);
  });

  /* --------------------------------------------------- labelling a lead */

  it('a salesperson labels a lead in their own branch', async () => {
    const res = await request(server())
      .put(`/lead-tags/lead/${leadMain}`)
      .set(auth(repA))
      .send({ tagIds: [potentialId] })
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Potential Lead');
  });

  it('applying the same set twice leaves one tag, not two', async () => {
    await request(server())
      .put(`/lead-tags/lead/${leadMain}`)
      .set(auth(repA))
      .send({ tagIds: [potentialId] })
      .expect(200);
    const rows = await prisma.leadTagAssignment.count({ where: { leadId: leadMain } });
    expect(rows).toBe(1);
  });

  it('sending a shorter set removes what is missing from it', async () => {
    const res = await request(server())
      .put(`/lead-tags/lead/${leadMain}`)
      .set(auth(repA))
      .send({ tagIds: [] })
      .expect(200);
    expect(res.body).toHaveLength(0);
    // Put it back for the retire test below.
    await request(server())
      .put(`/lead-tags/lead/${leadMain}`)
      .set(auth(repA))
      .send({ tagIds: [potentialId] })
      .expect(200);
  });

  it('a branch-scoped salesperson cannot label another branch of their own tenant', async () => {
    await request(server())
      .put(`/lead-tags/lead/${leadOther}`)
      .set(auth(repA))
      .send({ tagIds: [potentialId] })
      .expect(404);
    expect(await prisma.leadTagAssignment.count({ where: { leadId: leadOther } })).toBe(0);
  });

  it("a tenant cannot label another tenant's lead", async () => {
    await request(server())
      .put(`/lead-tags/lead/${leadB}`)
      .set(auth(hoA))
      .send({ tagIds: [potentialId] })
      .expect(404);
    expect(await prisma.leadTagAssignment.count({ where: { leadId: leadB } })).toBe(0);
  });

  it("a tag id from another tenant cannot be applied to our own lead", async () => {
    const theirs = await request(server()).get('/lead-tags').set(auth(hoB)).expect(200);
    await request(server())
      .put(`/lead-tags/lead/${leadMain}`)
      .set(auth(hoA))
      .send({ tagIds: [theirs.body[0].id] })
      .expect(404);
    // And the pre-existing label survived the refused write.
    expect(await prisma.leadTagAssignment.count({ where: { leadId: leadMain } })).toBe(1);
  });

  /* ------------------------------------------------------------ history */

  it('a tag change is written to the lead timeline, by name', async () => {
    const events = await prisma.activityEvent.findMany({
      where: { leadId: leadMain, type: 'lead.tags_changed' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.summary.includes('Potential Lead'))).toBe(true);
  });

  it('retiring a tag hides it from the picker but keeps it on the leads that carry it', async () => {
    const res = await request(server())
      .delete(`/lead-tags/${potentialId}`)
      .set(auth(hoA))
      .expect(200);
    expect(res.body.retired).toBe(true);
    expect(res.body.stillOnLeads).toBe(1);

    const active = await request(server()).get('/lead-tags').set(auth(hoA)).expect(200);
    expect(active.body).toHaveLength(0);

    const all = await request(server())
      .get('/lead-tags?includeInactive=true')
      .set(auth(hoA))
      .expect(200);
    expect(all.body).toHaveLength(1);
    expect(all.body[0].isActive).toBe(false);

    // The lead still carries it — the label is a record of what was thought.
    expect(await prisma.leadTagAssignment.count({ where: { leadId: leadMain } })).toBe(1);
  });
});
