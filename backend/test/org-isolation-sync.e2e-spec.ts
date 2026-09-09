import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * CaratOS Step 2 — SYNC PROVENANCE ISOLATION (org-scoped legacyId).
 *
 * The invariant: `organisation A + externalId X` must NEVER resolve to
 * `organisation B + externalId X`. Provenance keys (`legacyId`) are unique only
 * WITHIN an organisation now — the composite `@@unique([organisationId, legacyId])`
 * — so two tenants syncing their own ERP with an overlapping id get two
 * independent rows and can never overwrite each other's customer PII.
 *
 * This is a provenance-level guarantee, so it is asserted against PrismaService
 * directly (the exact upsert path the sync service uses), not over HTTP.
 *
 * Org A = the seeded "Eclat" organisation (org_eclat). Org B is built from
 * scratch with spec-unique ids so it can never collide with another spec file.
 * The shared provenance id both orgs sync is `SHARED_LEGACY`.
 */
const A_ORG = 'org_eclat';
const B_ORG = 'org_iso_sync';
const B_STORE = 'store_iso_sync';
const B_SLUG = 'iso-sync';
// A sentinel legacyId that cannot collide with any real org_eclat PartyNo.
const SHARED_LEGACY = 'ISO-SYNC-LEG-123';

describe('Sync provenance isolation — org-scoped legacyId (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = app.get(PrismaService);

    await teardown(prisma);
    await prisma.organisation.create({ data: { id: B_ORG, name: 'Iso Sync Jewels', slug: B_SLUG } });
    await prisma.store.create({ data: { id: B_STORE, name: 'Iso Sync Store', city: 'Testville', organisationId: B_ORG } });
  });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  // The exact provenance upsert the sync service performs.
  const upsertParty = (
    organisationId: string,
    legacyId: string,
    data: { name: string; phone: string; storeId?: string | null },
  ) =>
    prisma.party.upsert({
      where: { organisationId_legacyId: { organisationId, legacyId } },
      create: { organisationId, legacyId, ...data },
      update: data,
    });

  it('the same legacyId in two orgs yields two independent rows, correctly owned', async () => {
    const a = await upsertParty(A_ORG, SHARED_LEGACY, { name: 'Org A Customer', phone: '9990000001' });
    const b = await upsertParty(B_ORG, SHARED_LEGACY, { name: 'Org B Customer', phone: '9990000002', storeId: B_STORE });

    expect(a.id).not.toBe(b.id);
    expect(a.organisationId).toBe(A_ORG);
    expect(b.organisationId).toBe(B_ORG);

    // Exactly one row per org carries this provenance id — no collision, no merge.
    const rows = await prisma.party.findMany({ where: { legacyId: SHARED_LEGACY } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.organisationId))).toEqual(new Set([A_ORG, B_ORG]));
  });

  it('an org-B provenance upsert never touches org A’s row', async () => {
    // Seed A with known PII, then run an org-B-scoped upsert on the SAME legacyId
    // that rewrites B's name/phone. If organisationId did not participate in the
    // key, this would silently overwrite A's customer — the exact leak we close.
    await upsertParty(A_ORG, SHARED_LEGACY, { name: 'Org A Customer', phone: '9990000001' });
    await upsertParty(B_ORG, SHARED_LEGACY, { name: 'Org B RENAMED', phone: '9998887777', storeId: B_STORE });

    const a = await prisma.party.findFirst({ where: { organisationId: A_ORG, legacyId: SHARED_LEGACY } });
    expect(a?.name).toBe('Org A Customer');
    expect(a?.phone).toBe('9990000001');

    const b = await prisma.party.findFirst({ where: { organisationId: B_ORG, legacyId: SHARED_LEGACY } });
    expect(b?.name).toBe('Org B RENAMED');
    expect(b?.phone).toBe('9998887777');
  });
});

async function teardown(prisma: PrismaService) {
  // Remove the sentinel provenance row from BOTH orgs (incl. the org_eclat probe),
  // then Org B's children before the org itself (org FK is onDelete: RESTRICT).
  await prisma.party.deleteMany({ where: { legacyId: SHARED_LEGACY } });
  await prisma.store.deleteMany({ where: { organisationId: B_ORG } });
  await prisma.organisation.deleteMany({ where: { slug: B_SLUG } });
}
