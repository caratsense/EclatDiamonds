import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

/**
 * Filtering the CRM board by tag.
 *
 *  1. ANY OF THE SELECTED TAGS. "Potential or VIP" is the question people ask.
 *  2. NO TAGS SELECTED MEANS EVERY LEAD — never "untagged only".
 *  3. TAGS COMBINE with store, source, date, owner and search; each narrows.
 *  4. A FOREIGN TAG ID MATCHES NOTHING, in either direction, and is not an error
 *     that would confirm the id exists somewhere.
 *  5. A RETIRED TAG STILL FINDS THE LEADS THAT CARRY IT. Retiring takes a tag out
 *     of the picker, not off the record.
 *  6. SCOPE STILL WINS. A salesperson filtering by tag sees only their own leads.
 *  7. THE EXPORT READS THE SAME FILTER, so the file is the list on screen.
 */

const PASSWORD = 'password123';

const A = {
  org: 'org_tagf_a', slug: 'tagf-a', s1: 'store_tagf_s1', s2: 'store_tagf_s2',
  ho: 'ho@tagf-a.local', mgr: 'mgr@tagf-a.local', r1: 'r1@tagf-a.local', r2: 'r2@tagf-a.local',
};
const B = { org: 'org_tagf_b', slug: 'tagf-b', store: 'store_tagf_b', ho: 'ho@tagf-b.local' };

async function teardown(prisma: import('../src/prisma/prisma.service').PrismaService) {
  const orgs = [A.org, B.org];
  await prisma.auditLog.deleteMany({ where: { organisationId: { in: orgs } } }).catch(() => undefined);
  await prisma.leadTagAssignment.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.leadTag.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.lead.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: { in: orgs } } } });
  await prisma.user.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.store.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.organisation.deleteMany({ where: { id: { in: orgs } } });
}

describe('Lead tag filter (e2e)', () => {
  let app: INestApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  const tokens: Record<string, string> = {};
  const tag: Record<string, string> = {};

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const refs = async (token: string, query: Record<string, string>) => {
    const res = await request(server())
      .get('/leads')
      .query({ outcome: 'all', ...query })
      .set(auth(token))
      .expect(200);
    return (res.body as { ref: string }[]).map((l) => l.ref).sort();
  };

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
    await prisma.organisation.create({ data: { id: A.org, name: 'TagF A', slug: A.slug, industryPackCode: 'retail' } });
    await prisma.store.createMany({
      data: [
        { id: A.s1, name: 'One', city: 'Mumbai', organisationId: A.org, timezone: 'Asia/Kolkata' },
        { id: A.s2, name: 'Two', city: 'Pune', organisationId: A.org, timezone: 'Asia/Kolkata' },
      ],
    });
    const users: [string, string, string, string][] = [
      ['u_tagf_ho', A.ho, 'head_office', A.s1],
      ['u_tagf_mgr', A.mgr, 'store_manager', A.s1],
      ['u_tagf_r1', A.r1, 'salesperson', A.s1],
      ['u_tagf_r2', A.r2, 'salesperson', A.s1],
    ];
    for (const [id, email, role, storeId] of users) {
      await prisma.user.create({
        data: {
          id, email, name: id, role: role as never, passwordHash: hash, isActive: true,
          approvalStatus: 'approved', organisationId: A.org,
          userStores: { create: { storeId, isPrimary: true } },
        },
      });
    }
    await prisma.organisation.create({ data: { id: B.org, name: 'TagF B', slug: B.slug, industryPackCode: 'retail' } });
    await prisma.store.create({ data: { id: B.store, name: 'B', city: 'Delhi', organisationId: B.org, timezone: 'Asia/Kolkata' } });
    await prisma.user.create({
      data: {
        id: 'u_tagf_b_ho', email: B.ho, name: 'B HO', role: 'head_office', passwordHash: hash,
        isActive: true, approvalStatus: 'approved', organisationId: B.org,
        userStores: { create: { storeId: B.store, isPrimary: true } },
      },
    });

    for (const [key, org, name] of [
      ['potential', A.org, 'Potential'],
      ['vip', A.org, 'VIP'],
      ['old', A.org, 'Old campaign'],
      ['foreign', B.org, 'Potential'],
    ] as const) {
      tag[key] = (
        await prisma.leadTag.create({ data: { organisationId: org, name, slug: name.toLowerCase().replace(/\s+/g, '-') } })
      ).id;
    }

    const leads: {
      ref: string; org: string; storeId: string; ownerId: string | null; source: string;
      created: string; name: string; phone: string; tags: string[];
    }[] = [
      { ref: 'TF-1', org: A.org, storeId: A.s1, ownerId: 'u_tagf_r1', source: 'walk_in', created: '2026-09-01', name: 'Asha Mehta', phone: '9811100001', tags: ['potential'] },
      { ref: 'TF-2', org: A.org, storeId: A.s1, ownerId: 'u_tagf_r2', source: 'whatsapp', created: '2026-09-10', name: 'Bina Shah', phone: '9811100002', tags: ['potential', 'vip'] },
      { ref: 'TF-3', org: A.org, storeId: A.s2, ownerId: null, source: 'walk_in', created: '2026-09-05', name: 'Chetan Rao', phone: '9811100003', tags: ['vip'] },
      { ref: 'TF-4', org: A.org, storeId: A.s1, ownerId: 'u_tagf_r1', source: 'website', created: '2026-09-02', name: 'Dev Iyer', phone: '9811100004', tags: [] },
      { ref: 'TF-5', org: A.org, storeId: A.s1, ownerId: 'u_tagf_r1', source: 'walk_in', created: '2026-09-03', name: 'Esha Nair', phone: '9811100005', tags: ['old'] },
      { ref: 'TF-B', org: B.org, storeId: B.store, ownerId: null, source: 'walk_in', created: '2026-09-04', name: 'Other Tenant', phone: '9811100009', tags: ['foreign'] },
    ];
    for (const l of leads) {
      const lead = await prisma.lead.create({
        data: {
          organisationId: l.org, storeId: l.storeId, ref: l.ref, ownerId: l.ownerId,
          customerName: l.name, phone: l.phone, source: l.source as never, stage: 'inquiry',
          createdAt: new Date(`${l.created}T06:00:00.000Z`),
        },
      });
      if (l.tags.length) {
        await prisma.leadTagAssignment.createMany({
          data: l.tags.map((t) => ({ organisationId: l.org, leadId: lead.id, tagId: tag[t] })),
        });
      }
    }

    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201)).body.token;
    tokens.ho = await login(A.ho);
    tokens.mgr = await login(A.mgr);
    tokens.r1 = await login(A.r1);
    tokens.hoB = await login(B.ho);
  }, 120_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  it('one tag narrows to the leads carrying it', async () => {
    expect(await refs(tokens.ho, { tagIds: tag.potential })).toEqual(['TF-1', 'TF-2']);
  });

  it('several tags match ANY of them, comma list or repeated parameter', async () => {
    expect(await refs(tokens.ho, { tagIds: `${tag.potential},${tag.vip}` })).toEqual(['TF-1', 'TF-2', 'TF-3']);
    const res = await request(server())
      .get(`/leads?outcome=all&tagIds=${tag.potential}&tagIds=${tag.vip}`)
      .set(auth(tokens.ho))
      .expect(200);
    expect(res.body.map((l: { ref: string }) => l.ref).sort()).toEqual(['TF-1', 'TF-2', 'TF-3']);
  });

  it('an empty selection means every lead, not untagged only', async () => {
    expect(await refs(tokens.ho, { tagIds: '' })).toEqual(['TF-1', 'TF-2', 'TF-3', 'TF-4', 'TF-5']);
  });

  it('tags combine with store, source, date, owner and search', async () => {
    const both = `${tag.potential},${tag.vip}`;
    expect(await refs(tokens.ho, { tagIds: both, storeId: A.s2 })).toEqual(['TF-3']);
    expect(await refs(tokens.ho, { tagIds: both, source: 'whatsapp' })).toEqual(['TF-2']);
    expect(await refs(tokens.ho, { tagIds: both, from: '2026-09-04', to: '2026-09-30' })).toEqual(['TF-2', 'TF-3']);
    expect(await refs(tokens.ho, { tagIds: both, rep: 'u_tagf_r1' })).toEqual(['TF-1']);
    expect(await refs(tokens.ho, { tagIds: both, q: 'asha' })).toEqual(['TF-1']);
    expect(await refs(tokens.ho, { tagIds: both, q: '98111 00003' })).toEqual(['TF-3']);
    // Owner AND search are both OR-shaped internally; neither may replace the other.
    expect(await refs(tokens.ho, { rep: 'u_tagf_r1', q: 'Bina' })).toEqual([]);
  });

  it("another tenant's tag id matches nothing, in either direction", async () => {
    expect(await refs(tokens.ho, { tagIds: tag.foreign })).toEqual([]);
    expect(await refs(tokens.hoB, { tagIds: tag.potential })).toEqual([]);
    // Mixed with a real tag, the foreign id adds nothing.
    expect(await refs(tokens.ho, { tagIds: `${tag.foreign},${tag.vip}` })).toEqual(['TF-2', 'TF-3']);
  });

  it('a retired tag still finds the leads that carry it, but leaves the picker', async () => {
    await request(server()).delete(`/lead-tags/${tag.old}`).set(auth(tokens.ho)).expect((r) => {
      if (r.status >= 300) throw new Error(`retire returned ${r.status}`);
    });
    const picker = await request(server()).get('/lead-tags').set(auth(tokens.ho)).expect(200);
    expect(picker.body.map((t: { id: string }) => t.id)).not.toContain(tag.old);
    expect(await refs(tokens.ho, { tagIds: tag.old })).toEqual(['TF-5']);
  });

  it('a salesperson filtering by tag still sees only their own leads', async () => {
    expect(await refs(tokens.r1, { tagIds: `${tag.potential},${tag.vip}` })).toEqual(['TF-1']);
    expect(await refs(tokens.r1, {})).toEqual(['TF-1', 'TF-4', 'TF-5']);
  });

  it('a malformed filter is refused rather than ignored', async () => {
    await request(server()).get('/leads').query({ source: 'carrier_pigeon' }).set(auth(tokens.ho)).expect(400);
  });

  it('the export receives the same tag and search filter', async () => {
    const count = await request(server())
      .get('/crm/exports/leads/count')
      .query({ tagIds: `${tag.potential},${tag.vip}` })
      .set(auth(tokens.mgr))
      .expect(200);
    // The branch manager's scope is store one: TF-1 and TF-2, not TF-3.
    expect(count.body.rows).toBe(2);

    const file = await request(server())
      .get('/crm/exports/leads.xlsx')
      .query({ tagIds: tag.potential, q: 'bina' })
      .set(auth(tokens.mgr))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(file.headers['x-export-rows']).toBe('1');

    // A foreign tag in the export is as empty as it is on the board.
    const foreign = await request(server())
      .get('/crm/exports/leads/count')
      .query({ tagIds: tag.foreign })
      .set(auth(tokens.mgr))
      .expect(200);
    expect(foreign.body.rows).toBe(0);
  });
});
