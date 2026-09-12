import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * The design, the piece, and when the piece counts as dead.
 *
 *  1. A STYLE IS NOT A SKU. Many SKUs share one style number, and the importer
 *     writes it as its own field rather than copying the SKU into it — a style
 *     number that is secretly the SKU makes every "how is this design selling"
 *     answer a per-piece answer wearing a design's label.
 *
 *  2. A VIN IS OURS, AND IS ISSUED ONCE. Every other code on a piece belongs to
 *     somebody else and the SKU is shared across identical pieces. Re-issuing
 *     would make the number printed on a tag point at nothing.
 *
 *  3. THE THRESHOLD IS THE TENANT'S. A chain moves in weeks, a bridal set is
 *     meant to sit. 180 days for both produces a figure nobody acts on.
 *
 *  4. NOTHING CHANGES FOR A TENANT THAT CONFIGURES NOTHING.
 */

const PASSWORD = 'password123';

const A = {
  org: 'org_sv_a',
  slug: 'sv-a',
  store: 'store_sv_a',
  ho: 'ho.sv@sv-a.local',
  mgr: 'mgr.sv@sv-a.local',
  rep: 'rep.sv@sv-a.local',
};

const DAY = 86_400_000;

async function teardown(prisma: PrismaService) {
  await prisma.deadStockPolicy.deleteMany({ where: { organisationId: A.org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: A.org } });
  await prisma.stockItem.deleteMany({ where: { organisationId: A.org } });
  await prisma.productEmbedding.deleteMany({ where: { product: { organisationId: A.org } } });
  await prisma.product.deleteMany({ where: { organisationId: A.org } });
  await prisma.importBatch.deleteMany({ where: { organisationId: A.org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: A.org } } });
  await prisma.user.deleteMany({ where: { organisationId: A.org } });
  await prisma.store.deleteMany({ where: { organisationId: A.org } });
  await prisma.organisation.deleteMany({ where: { id: A.org } });
  await prisma.docSequence.deleteMany({ where: { scope: `vin:${A.org}` } });
}

describe('Style number, VIN and configurable dead stock (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let hoT: string;
  let mgrT: string;
  let repT: string;
  let seq = 0;

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  /** A piece that came in `ageDays` ago. */
  async function piece(opts: {
    sku: string;
    ageDays: number;
    category?: string;
    styleNumber?: string;
    tagPrice?: number;
  }) {
    seq += 1;
    return prisma.stockItem.create({
      data: {
        organisationId: A.org,
        storeId: A.store,
        sku: opts.sku,
        name: `Piece ${opts.sku}`,
        category: (opts.category ?? 'ring') as never,
        metal: 'gold_22k',
        status: 'in_stock',
        styleNumber: opts.styleNumber,
        inwardDate: new Date(Date.now() - opts.ageDays * DAY),
        tagPrice: opts.tagPrice ?? 10_000,
      },
      select: { id: true, sku: true },
    });
  }

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
      data: { id: A.org, name: 'SV A', slug: A.slug, industryPackCode: 'jewellery' },
    });
    await prisma.store.create({
      data: { id: A.store, name: 'Bandra', city: 'Mumbai', organisationId: A.org },
    });
    for (const [id, email, role] of [
      ['u_sv_ho', A.ho, 'head_office'],
      ['u_sv_mgr', A.mgr, 'store_manager'],
      ['u_sv_rep', A.rep, 'salesperson'],
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
          userStores: { create: { storeId: A.store, isPrimary: true } },
        },
      });
    }

    const login = async (email: string) =>
      (
        await request(server())
          .post('/auth/login')
          .send({ email, password: PASSWORD })
          .expect(201)
      ).body.token;
    hoT = await login(A.ho);
    mgrT = await login(A.mgr);
    repT = await login(A.rep);
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  // ==========================================================================
  // 1. Style number
  // ==========================================================================

  it('an import writes the style number as its own field, never the SKU', async () => {
    const csv = [
      'Design Code,Item Name,Style No,Gross Wt',
      'RING-A-6,Solitaire ring size 6,ST-9001,3.200',
      'RING-A-7,Solitaire ring size 7,ST-9001,3.400',
      'RING-B-6,Halo ring size 6,ST-9002,4.100',
    ].join('\n');

    const discover = await request(server())
      .post('/imports/products/discover')
      .set(auth(mgrT))
      .attach('file', Buffer.from(csv), { filename: 'stock.csv', contentType: 'text/csv' })
      .expect(201);

    // The dictionary recognises "Style No" on its own — it is not swallowed by
    // the SKU aliases, which also cover design/style wording.
    const styleSuggestion = discover.body.suggestions.find(
      (s: { sourceColumn: string }) => s.sourceColumn === 'Style No',
    );
    expect(styleSuggestion.canonicalField).toBe('styleNumber');

    const mappings = JSON.stringify([
      { sourceColumn: 'Design Code', canonicalField: 'sku' },
      { sourceColumn: 'Item Name', canonicalField: 'name' },
      { sourceColumn: 'Style No', canonicalField: 'styleNumber' },
      { sourceColumn: 'Gross Wt', canonicalField: 'weightGrams' },
    ]);

    await request(server())
      .post('/imports/products/run')
      .set(auth(mgrT))
      .field('mappings', mappings)
      .field('storeId', A.store)
      .attach('file', Buffer.from(csv), { filename: 'stock.csv', contentType: 'text/csv' })
      .expect(201);

    const products = await prisma.product.findMany({
      where: { organisationId: A.org },
      orderBy: { sku: 'asc' },
    });
    expect(products).toHaveLength(3);
    // Two SKUs, one design. That relationship is the entire point.
    expect(products.filter((p) => p.styleNumber === 'ST-9001')).toHaveLength(2);
    expect(products.find((p) => p.sku === 'RING-B-6')!.styleNumber).toBe('ST-9002');
    // And it is NOT a copy of the SKU.
    expect(products.every((p) => p.styleNumber !== p.sku)).toBe(true);
  });

  it('a file without the column does not blank a style number somebody typed', async () => {
    const csv = ['Design Code,Item Name', 'RING-A-6,Solitaire ring size 6 revised'].join('\n');
    await request(server())
      .post('/imports/products/run')
      .set(auth(mgrT))
      .field(
        'mappings',
        JSON.stringify([
          { sourceColumn: 'Design Code', canonicalField: 'sku' },
          { sourceColumn: 'Item Name', canonicalField: 'name' },
        ]),
      )
      .field('storeId', A.store)
      .attach('file', Buffer.from(csv), { filename: 'stock.csv', contentType: 'text/csv' })
      .expect(201);

    const p = await prisma.product.findFirst({
      where: { organisationId: A.org, sku: 'RING-A-6' },
    });
    expect(p!.name).toContain('revised');
    // Still there. A source that does not send style numbers must not erase them.
    expect(p!.styleNumber).toBe('ST-9001');
  });

  // ==========================================================================
  // 2. VIN
  // ==========================================================================

  it('a VIN is issued once, and issuing again returns the same one', async () => {
    const item = await piece({ sku: 'VIN-1', ageDays: 10 });

    const first = await request(server())
      .post(`/stock/vin/issue/${item.id}`)
      .set(auth(mgrT))
      .expect(201);
    expect(first.body.issued).toBe(true);
    expect(first.body.vin).toMatch(/^\d{8}[0-9A-Z]$/);

    // The number is on a physical tag now. Re-issuing would make that tag point
    // at nothing.
    const second = await request(server())
      .post(`/stock/vin/issue/${item.id}`)
      .set(auth(mgrT))
      .expect(201);
    expect(second.body.issued).toBe(false);
    expect(second.body.vin).toBe(first.body.vin);
  });

  it('a salesperson cannot issue one', async () => {
    const item = await piece({ sku: 'VIN-2', ageDays: 5 });
    await request(server()).post(`/stock/vin/issue/${item.id}`).set(auth(repT)).expect(403);
  });

  it('four identical rings get four different numbers', async () => {
    for (const n of [3, 4, 5, 6]) await piece({ sku: 'RING-IDENTICAL', ageDays: n });

    const res = await request(server())
      .post('/stock/vin/issue-missing')
      .set(auth(mgrT))
      .send({ storeId: A.store })
      .expect(201);
    expect(res.body.issued).toBeGreaterThanOrEqual(4);
    expect(res.body.remaining).toBe(0);

    const same = await prisma.stockItem.findMany({
      where: { organisationId: A.org, sku: 'RING-IDENTICAL' },
      select: { vin: true },
    });
    expect(same).toHaveLength(4);
    // The SKU is the design; it cannot tell these four apart. The VIN can.
    expect(new Set(same.map((s) => s.vin)).size).toBe(4);
  });

  it('a second sweep issues nothing', async () => {
    const res = await request(server())
      .post('/stock/vin/issue-missing')
      .set(auth(mgrT))
      .send({ storeId: A.store })
      .expect(201);
    expect(res.body.issued).toBe(0);
  });

  it('a piece is found by the number on its tag, however it is typed', async () => {
    const item = await prisma.stockItem.findFirst({
      where: { organisationId: A.org, sku: 'VIN-1' },
    });
    const vin = item!.vin!;

    const exact = await request(server())
      .get(`/stock/vin/${vin}`)
      .set(auth(repT))
      .expect(200);
    expect(exact.body.found).toBe(true);
    expect(exact.body.sku).toBe('VIN-1');

    // Read off a tag, with the spacing people add.
    const spaced = await request(server())
      .get(`/stock/vin/${encodeURIComponent(`${vin.slice(0, 4)}-${vin.slice(4)}`)}`)
      .set(auth(repT))
      .expect(200);
    expect(spaced.body.found).toBe(true);
  });

  it('a number nobody issued is reported as not found, not as an error', async () => {
    const res = await request(server()).get('/stock/vin/990000000').set(auth(repT)).expect(200);
    // A well-formed number can belong to a piece that was sold or never entered.
    // That is a fact about the catalogue, not a validation failure.
    expect(res.body.found).toBe(false);
  });

  it('a transposed digit is a different number, not a near miss', async () => {
    const item = await prisma.stockItem.findFirst({
      where: { organisationId: A.org, sku: 'VIN-1' },
    });
    const vin = item!.vin!;
    // Swap the last two digits of the body. The check character no longer agrees,
    // so this is simply a code nothing answers to — rather than silently
    // resolving to a different ring, which is the failure that matters.
    const body = vin.slice(0, 8);
    const swapped = `${body.slice(0, 6)}${body[7]}${body[6]}${vin[8]}`;
    if (swapped !== vin) {
      const res = await request(server()).get(`/stock/vin/${swapped}`).set(auth(repT)).expect(200);
      expect(res.body.found).toBe(false);
    }
  });

  // ==========================================================================
  // 3. Dead stock
  // ==========================================================================

  it('with no policy configured, the platform default still applies', async () => {
    const policy = await request(server()).get('/stock/dead/policy').set(auth(mgrT)).expect(200);
    expect(policy.body.usingPlatformDefault).toBe(true);
    expect(policy.body.defaultThresholdDays).toBe(180);

    await piece({ sku: 'OLD-CHAIN', ageDays: 200, category: 'chain' });
    await piece({ sku: 'OLD-BRIDAL', ageDays: 200, category: 'necklace' });
    await piece({ sku: 'NEW-CHAIN', ageDays: 30, category: 'chain' });

    const dead = await request(server()).get('/stock/dead').set(auth(mgrT)).expect(200);
    // Both 200-day pieces, neither 30-day one.
    expect(dead.body.items.map((i: { sku: string }) => i.sku).sort()).toEqual([
      'OLD-BRIDAL',
      'OLD-CHAIN',
    ]);
  });

  it('only head office sets the threshold', async () => {
    await request(server())
      .put('/stock/dead/policy')
      .set(auth(mgrT))
      .send({ thresholdDays: 90 })
      .expect(403);
  });

  it('a chain and a bridal set stop being the same question', async () => {
    // A chain should move in a season; a necklace is expected to sit.
    await request(server())
      .put('/stock/dead/policy')
      .set(auth(hoT))
      .send({ category: 'chain', thresholdDays: 45, warnAfterDays: 30 })
      .expect(200);
    await request(server())
      .put('/stock/dead/policy')
      .set(auth(hoT))
      .send({ category: 'necklace', thresholdDays: 365 })
      .expect(200);

    const dead = await request(server()).get('/stock/dead').set(auth(mgrT)).expect(200);
    const skus = dead.body.items.map((i: { sku: string }) => i.sku).sort();
    // The 200-day chain is dead at 45. The 200-day necklace is not, at 365.
    expect(skus).toEqual(['OLD-CHAIN']);

    const row = dead.body.items[0];
    expect(row.thresholdDays).toBe(45);
    // How far past the line, so the list can be worked worst-first.
    expect(row.daysOver).toBeGreaterThan(150);
  });

  it('the warning band shows pieces heading that way, without calling them dead', async () => {
    await piece({ sku: 'WARN-CHAIN', ageDays: 35, category: 'chain' });

    const strict = await request(server()).get('/stock/dead').set(auth(mgrT)).expect(200);
    expect(strict.body.items.map((i: { sku: string }) => i.sku)).not.toContain('WARN-CHAIN');

    const wide = await request(server())
      .get('/stock/dead?includeWarning=true')
      .set(auth(mgrT))
      .expect(200);
    const warn = wide.body.items.find((i: { sku: string }) => i.sku === 'WARN-CHAIN');
    expect(warn.state).toBe('ageing');
    // The headline and the rows come from one pass, so they cannot disagree.
    expect(wide.body.dead).toBe(wide.body.items.filter((i: { state: string }) => i.state === 'dead').length);
  });

  it('a warning that fires after the piece is already dead is refused', async () => {
    const res = await request(server())
      .put('/stock/dead/policy')
      .set(auth(hoT))
      .send({ category: 'ring', thresholdDays: 60, warnAfterDays: 90 })
      .expect(400);
    expect(JSON.stringify(res.body)).toMatch(/BEFORE/i);
  });

  it('the tenant default covers everything without its own rule', async () => {
    await request(server())
      .put('/stock/dead/policy')
      .set(auth(hoT))
      .send({ thresholdDays: 100 })
      .expect(200);

    await piece({ sku: 'OLD-RING', ageDays: 120, category: 'ring' });
    const dead = await request(server()).get('/stock/dead').set(auth(mgrT)).expect(200);
    const ring = dead.body.items.find((i: { sku: string }) => i.sku === 'OLD-RING');
    expect(ring.thresholdDays).toBe(100);

    // And the categories with their own rules still use those.
    const chain = dead.body.items.find((i: { sku: string }) => i.sku === 'OLD-CHAIN');
    expect(chain.thresholdDays).toBe(45);
  });

  it('the stock summary agrees with the dead-stock list', async () => {
    const summary = await request(server())
      .get('/stock/summary')
      .set(auth(mgrT))
      .set('X-Store-Id', A.store)
      .expect(200);
    const dead = await request(server())
      .get('/stock/dead?limit=500')
      .set(auth(mgrT))
      .expect(200);

    // One definition of "dead", read by both. Before this they were two
    // constants in two files, and the KPI card disagreed with the table under it.
    expect(summary.body.deadStock).toBe(dead.body.dead);
  });

  it('there can be exactly one default rule', async () => {
    await request(server())
      .put('/stock/dead/policy')
      .set(auth(hoT))
      .send({ thresholdDays: 120 })
      .expect(200);

    const defaults = await prisma.deadStockPolicy.count({
      where: { organisationId: A.org, category: null },
    });
    expect(defaults).toBe(1);
    const policy = await request(server()).get('/stock/dead/policy').set(auth(hoT)).expect(200);
    expect(policy.body.defaultThresholdDays).toBe(120);
  });

  it('clearing a rule falls back to the default, and clearing the default to the platform', async () => {
    await request(server()).delete('/stock/dead/policy/chain').set(auth(hoT)).expect(200);
    const dead = await request(server()).get('/stock/dead').set(auth(mgrT)).expect(200);
    const chain = dead.body.items.find((i: { sku: string }) => i.sku === 'OLD-CHAIN');
    expect(chain.thresholdDays).toBe(120);

    await request(server()).delete('/stock/dead/policy/default').set(auth(hoT)).expect(200);
    const policy = await request(server()).get('/stock/dead/policy').set(auth(hoT)).expect(200);
    expect(policy.body.defaultThresholdDays).toBe(180);
  });
});
