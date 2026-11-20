import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * CaratOS Step 2 — TENANT ISOLATION, PART 3.3/3.4 (marketing + new-store).
 *
 * Org A = seeded Eclat (org_eclat), head office = head.office@caratsense.in. We
 * stand up a separate Org B and prove that Org A head office can neither list
 * nor mutate Org B's marketing campaigns/assets/agency-tasks nor its new-store
 * launch projects/checklists/milestones/vendors — while Org B head office still
 * sees and can act on its own. Sentinel `ISO-MKT` must never leak into an Org-A
 * response.
 */
const PASSWORD = 'password123';
const A_HO = 'head.office@caratsense.in';
const SENTINEL = 'ISO-MKT';

const ORG = 'org_iso_mkt';
const STORE = 'store_iso_mkt';
const SLUG = 'iso-mkt';
const B_HO = 'ho.mkt@iso-mkt.local';

const CAMP = 'camp_iso_mkt';
const ASSET = 'asset_iso_mkt';
const TASK = 'task_iso_mkt';
const PROJ = 'proj_iso_mkt';
const CHK = 'chk_iso_mkt';
const MILE = 'mile_iso_mkt';
const VEND = 'vend_iso_mkt';

describe('Organisation isolation — marketing + new-store (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens: Record<string, string> = {};
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const get = (path: string, t: string) => request(app.getHttpServer()).get(path).set(auth(t));
  const patch = (path: string, t: string) => request(app.getHttpServer()).patch(path).set(auth(t));
  const login = async (email: string) => {
    const r = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    expect(r.status).toBe(201);
    return r.body.token as string;
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
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

    const hash = await bcrypt.hash(PASSWORD, 10);
    await teardown(prisma);

    // Marketing and new-store are jewellery-pack modules; the entitlement
    // guard refuses them to a tenant with no industry.
    await prisma.organisation.create({
      data: { id: ORG, name: 'ISO-MKT Jewels', slug: SLUG, industryPackCode: 'jewellery' },
    });
    await prisma.store.create({
      data: { id: STORE, name: 'ISO-MKT Store', city: 'Testville', organisationId: ORG },
    });
    await prisma.user.create({
      data: {
        email: B_HO,
        name: 'HO MKT',
        role: 'head_office',
        passwordHash: hash,
        isActive: true,
        approvalStatus: 'approved',
        organisationId: ORG,
      },
    });

    // Marketing: campaign (targeting the org's store) + a deliverable asset + an agency task.
    await prisma.marketingCampaign.create({
      data: {
        id: CAMP,
        organisationId: ORG,
        name: `${SENTINEL} Diwali Campaign`,
        type: 'festive',
        status: 'planning',
        stores: { create: { storeId: STORE } },
      },
    });
    await prisma.marketingAsset.create({
      data: { id: ASSET, campaignId: CAMP, title: `${SENTINEL} Poster`, status: 'pending' },
    });
    await prisma.marketingAsset.create({
      data: { id: TASK, campaignId: CAMP, title: `${SENTINEL} Brief`, status: 'pending' },
    });

    // New-store launch: project + one checklist item, milestone, vendor.
    await prisma.newStoreProject.create({
      data: { id: PROJ, organisationId: ORG, name: `${SENTINEL} Launch Surat`, city: 'Surat' },
    });
    await prisma.newStoreChecklistItem.create({
      data: { id: CHK, projectId: PROJ, department: 'inventory', title: `${SENTINEL} tagging`, status: 'todo' },
    });
    await prisma.newStoreMilestone.create({
      data: { id: MILE, projectId: PROJ, marker: 'T-30', title: `${SENTINEL} fitout`, date: new Date('2026-09-01'), state: 'upcoming' },
    });
    await prisma.newStoreVendor.create({
      data: { id: VEND, projectId: PROJ, name: `${SENTINEL} Interiors Co`, task: 'fitout', status: 'pending' },
    });

    tokens.aHo = await login(A_HO);
    tokens.bHo = await login(B_HO);
  });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  // ---- Marketing: Org A must not read or mutate Org B ---------------------------
  it('A head office campaign listing excludes the Org-B campaign', async () => {
    const r = await get('/marketing/campaigns', tokens.aHo);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(SENTINEL);
  });

  it('A head office cannot update an Org-B marketing asset', async () => {
    const r = await patch(`/marketing/assets/${ASSET}`, tokens.aHo).send({ status: 'approved' });
    expect([403, 404]).toContain(r.status);
    const after = await prisma.marketingAsset.findUnique({ where: { id: ASSET } });
    expect(after?.status).toBe('pending');
  });

  it('A head office cannot update an Org-B agency task', async () => {
    const r = await patch(`/marketing/agency-tasks/${TASK}`, tokens.aHo).send({ status: 'approved' });
    expect([403, 404]).toContain(r.status);
    const after = await prisma.marketingAsset.findUnique({ where: { id: TASK } });
    expect(after?.status).toBe('pending');
  });

  // ---- New-store: Org A must not read or mutate Org B --------------------------
  it('A head office new-store project listing excludes the Org-B project', async () => {
    const r = await get('/new-store/projects', tokens.aHo);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(SENTINEL);
  });

  it('A head office cannot update an Org-B checklist item', async () => {
    const r = await patch(`/new-store/checklist/${CHK}`, tokens.aHo).send({ status: 'done' });
    expect([403, 404]).toContain(r.status);
    const after = await prisma.newStoreChecklistItem.findUnique({ where: { id: CHK } });
    expect(after?.status).toBe('todo');
  });

  it('A head office cannot update an Org-B milestone', async () => {
    const r = await patch(`/new-store/milestones/${MILE}`, tokens.aHo).send({ status: 'done' });
    expect([403, 404]).toContain(r.status);
    const after = await prisma.newStoreMilestone.findUnique({ where: { id: MILE } });
    expect(after?.state).toBe('upcoming');
  });

  it('A head office cannot update an Org-B vendor', async () => {
    const r = await patch(`/new-store/vendors/${VEND}`, tokens.aHo).send({ status: 'paid' });
    expect([403, 404]).toContain(r.status);
    const after = await prisma.newStoreVendor.findUnique({ where: { id: VEND } });
    expect(after?.status).toBe('pending');
  });

  // ---- Legitimate same-org access still works ---------------------------------
  it('B head office sees its own campaign and can approve its own asset', async () => {
    const list = await get('/marketing/campaigns', tokens.bHo);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain(SENTINEL);

    const r = await patch(`/marketing/assets/${ASSET}`, tokens.bHo).send({ status: 'approved' });
    expect([200, 201]).toContain(r.status);
    const after = await prisma.marketingAsset.findUnique({ where: { id: ASSET } });
    expect(after?.status).toBe('approved');
  });

  it('B head office sees its own project and can complete its own checklist item', async () => {
    const list = await get('/new-store/projects', tokens.bHo);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain(SENTINEL);

    const r = await patch(`/new-store/checklist/${CHK}`, tokens.bHo).send({ status: 'done' });
    expect([200, 201]).toContain(r.status);
    const after = await prisma.newStoreChecklistItem.findUnique({ where: { id: CHK } });
    expect(after?.status).toBe('done');
  });
});

async function teardown(prisma: PrismaService) {
  // Campaigns cascade CampaignStore + MarketingAsset; projects cascade their children.
  await prisma.marketingCampaign.deleteMany({ where: { organisationId: ORG } });
  await prisma.newStoreProject.deleteMany({ where: { organisationId: ORG } });
  await prisma.userStore.deleteMany({ where: { store: { organisationId: ORG } } });
  // AuditLog.actorId -> User is onDelete: RESTRICT; clear org-B audit rows (from the
  // spec's own Org-B HO mutations) before the users they reference.
  await prisma.auditLog.deleteMany({ where: { organisationId: ORG } });
  await prisma.user.deleteMany({ where: { organisationId: ORG } });
  await prisma.store.deleteMany({ where: { organisationId: ORG } });
  await prisma.organisation.deleteMany({ where: { slug: SLUG } });
}
