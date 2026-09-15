import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { Workbook } from 'exceljs';

import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Block 9 — not every old piece is dead merchandise.
 *
 *  1. A DESIGN AND A PIECE CAN EACH BE CLASSIFIED. Standard, customised (made to
 *     order), non-stock (display / sample). A piece with no classification of its
 *     own inherits its design's.
 *
 *  2. THE IMPORT CARRIES IT, NORMALISED, AND NEVER GUESSES. "Made to order" is
 *     customised; a bare "Y" is a warning, not a classification.
 *
 *  3. A CUSTOMISED PIECE IS NOT SELLABLE. Not in the catalogue's "on the shelf"
 *     count, not in the counter's piece list, never told to "sell".
 *
 *  4. THE DEAD-STOCK SCREEN REPORTS FOUR THINGS: ordinary dead stock, customised
 *     pieces, pieces marked for remaking, and excluded non-stock — and the stock
 *     summary's dead figure is the first of those, not all four.
 *
 *  5. THE EXPORT CARRIES THE CLASSIFICATION.
 */

const PASSWORD = 'password123';

const A = {
  org: 'org_sc_a',
  slug: 'sc-a',
  store: 'store_sc_a',
  far: 'store_sc_far',
  ho: 'ho.sc@sc-a.local',
  mgr: 'mgr.sc@sc-a.local',
  rep: 'rep.sc@sc-a.local',
};
const B = { org: 'org_sc_b', slug: 'sc-b', store: 'store_sc_b', ho: 'ho.sc@sc-b.local' };

const DAY = 86_400_000;

async function teardown(prisma: PrismaService) {
  for (const org of [A.org, B.org]) {
    await prisma.deadStockPolicy.deleteMany({ where: { organisationId: org } });
    await prisma.auditLog.deleteMany({ where: { organisationId: org } });
    await prisma.stockItem.deleteMany({ where: { organisationId: org } });
    await prisma.productEmbedding.deleteMany({ where: { product: { organisationId: org } } });
    await prisma.product.deleteMany({ where: { organisationId: org } });
    await prisma.importBatch.deleteMany({ where: { organisationId: org } });
    await prisma.userStore.deleteMany({ where: { user: { organisationId: org } } });
    await prisma.user.deleteMany({ where: { organisationId: org } });
    await prisma.store.deleteMany({ where: { organisationId: org } });
    await prisma.organisation.deleteMany({ where: { id: org } });
  }
}

describe('Stock classification and dead-stock views (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hoT: string;
  let mgrT: string;
  let repT: string;
  let otherHoT: string;

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const ids: Record<string, string> = {};

  async function design(sku: string, stockClass: 'standard' | 'customised' | 'non_stock' = 'standard') {
    const p = await prisma.product.create({
      data: {
        organisationId: A.org,
        sku,
        name: `Design ${sku}`,
        category: 'ring',
        metal: 'gold_22k',
        stockClass,
      },
      select: { id: true },
    });
    return p.id;
  }

  async function piece(opts: {
    sku: string;
    ageDays: number;
    productId?: string;
    stockClass?: 'standard' | 'customised' | 'non_stock';
    storeId?: string;
  }) {
    const s = await prisma.stockItem.create({
      data: {
        organisationId: A.org,
        storeId: opts.storeId ?? A.store,
        productId: opts.productId,
        sku: opts.sku,
        name: `Piece ${opts.sku}`,
        category: 'ring',
        metal: 'gold_22k',
        status: 'in_stock',
        stockClass: opts.stockClass,
        inwardDate: new Date(Date.now() - opts.ageDays * DAY),
        tagPrice: 10_000,
      },
      select: { id: true },
    });
    ids[opts.sku] = s.id;
    return s.id;
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
    for (const o of [A, B]) {
      await prisma.organisation.create({
        data: { id: o.org, name: o.slug, slug: o.slug, industryPackCode: 'jewellery' },
      });
    }
    await prisma.store.create({ data: { id: A.store, name: 'Bandra', city: 'Mumbai', organisationId: A.org } });
    await prisma.store.create({ data: { id: A.far, name: 'Udaipur', city: 'Udaipur', organisationId: A.org } });
    await prisma.store.create({ data: { id: B.store, name: 'Other', city: 'Pune', organisationId: B.org } });

    const users: [string, string, string, string, string[]][] = [
      ['u_sc_ho', A.ho, 'head_office', A.org, [A.store, A.far]],
      ['u_sc_mgr', A.mgr, 'store_manager', A.org, [A.store]],
      ['u_sc_rep', A.rep, 'salesperson', A.org, [A.store]],
      ['u_sc_ho_b', B.ho, 'head_office', B.org, [B.store]],
    ];
    for (const [id, email, role, org, stores] of users) {
      await prisma.user.create({
        data: {
          id,
          email,
          name: id,
          role: role as never,
          passwordHash: hash,
          isActive: true,
          approvalStatus: 'approved',
          organisationId: org,
          userStores: { create: stores.map((storeId, i) => ({ storeId, isPrimary: i === 0 })) },
        },
      });
    }
    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201)).body.token;
    hoT = await login(A.ho);
    mgrT = await login(A.mgr);
    repT = await login(A.rep);
    otherHoT = await login(B.ho);
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  // ==========================================================================
  // 1. Import
  // ==========================================================================

  it('the import maps a classification column and normalises its words', async () => {
    const csv = [
      'Design Code,Item Name,Stock Type',
      'MTO-1,Bridal choker,Made to order',
      'DSP-1,Window necklace,Display',
      'STD-1,Plain band,Ready stock',
      'ODD-1,Mystery ring,Y',
    ].join('\n');

    const discover = await request(server())
      .post('/imports/products/discover')
      .set(auth(mgrT))
      .attach('file', Buffer.from(csv), { filename: 'stock.csv', contentType: 'text/csv' })
      .expect(201);
    const suggestion = discover.body.suggestions.find(
      (s: { sourceColumn: string }) => s.sourceColumn === 'Stock Type',
    );
    expect(suggestion.canonicalField).toBe('stockClass');

    const mappings = JSON.stringify([
      { sourceColumn: 'Design Code', canonicalField: 'sku' },
      { sourceColumn: 'Item Name', canonicalField: 'name' },
      { sourceColumn: 'Stock Type', canonicalField: 'stockClass' },
    ]);

    const preview = await request(server())
      .post('/imports/products/preview')
      .set(auth(mgrT))
      .field('mappings', mappings)
      .field('storeId', A.store)
      .attach('file', Buffer.from(csv), { filename: 'stock.csv', contentType: 'text/csv' })
      .expect(201);
    const odd = preview.body.sampleRows.find((r: { value: { sku: string } | null }) => r.value?.sku === 'ODD-1');
    // "Y" under "Stock Type" could mean made-to-order or display. Reported, not guessed.
    expect(odd.status).toBe('warning');
    expect(odd.issues.map((i: { code: string }) => i.code)).toContain('invalid_stock_class');

    await request(server())
      .post('/imports/products/run')
      .set(auth(mgrT))
      .field('mappings', mappings)
      .field('storeId', A.store)
      .attach('file', Buffer.from(csv), { filename: 'stock.csv', contentType: 'text/csv' })
      .expect(201);

    const bySku = Object.fromEntries(
      (
        await prisma.product.findMany({
          where: { organisationId: A.org, sku: { in: ['MTO-1', 'DSP-1', 'STD-1', 'ODD-1'] } },
          select: { sku: true, stockClass: true },
        })
      ).map((p) => [p.sku, p.stockClass]),
    );
    expect(bySku).toEqual({
      'MTO-1': 'customised',
      'DSP-1': 'non_stock',
      'STD-1': 'standard',
      'ODD-1': 'standard',
    });
  });

  it('a re-import without the column does not reset a made-to-order design', async () => {
    const csv = ['Design Code,Item Name', 'MTO-1,Bridal choker revised'].join('\n');
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
    const p = await prisma.product.findFirst({ where: { organisationId: A.org, sku: 'MTO-1' } });
    expect(p!.name).toContain('revised');
    expect(p!.stockClass).toBe('customised');
  });

  // ==========================================================================
  // 2. Sellable
  // ==========================================================================

  it('a customised piece is not on the shelf for the catalogue or the counter', async () => {
    const standard = await design('SELL-STD');
    await piece({ sku: 'SELL-STD-1', ageDays: 5, productId: standard });
    // One piece of an ordinary design, made for a customer.
    await piece({ sku: 'SELL-STD-2', ageDays: 5, productId: standard, stockClass: 'customised' });

    const mto = await design('SELL-MTO', 'customised');
    await piece({ sku: 'SELL-MTO-1', ageDays: 5, productId: mto });

    const get = async (id: string) =>
      (await request(server()).get(`/products/${id}`).set(auth(repT)).set('X-Store-Id', A.store).expect(200)).body;

    const std = await get(standard);
    expect(std.stock.hereCount).toBe(1);
    expect(std.stock.totalCount).toBe(1);

    const madeToOrder = await get(mto);
    // Its only piece is spoken for, so the honest answer is "we can make it".
    expect(madeToOrder.stock.totalCount).toBe(0);
    expect(madeToOrder.stock.where).toBe('made');
    expect(madeToOrder.stockClass).toBe('customised');

    const pieces = await request(server())
      .get(`/products/${standard}/pieces`)
      .set(auth(repT))
      .set('X-Store-Id', A.store)
      .expect(200);
    expect(pieces.body.map((p: { id: string }) => p.id)).toEqual([ids['SELL-STD-1']]);
  });

  // ==========================================================================
  // 3. Dead-stock views
  // ==========================================================================

  it('the four views each report their own pieces, and the counts come with every view', async () => {
    const std = await design('DEAD-STD');
    const mto = await design('DEAD-MTO', 'customised');
    await piece({ sku: 'D-ORDINARY', ageDays: 400, productId: std });
    await piece({ sku: 'D-CUSTOM-INHERIT', ageDays: 400, productId: mto });
    await piece({ sku: 'D-CUSTOM-OWN', ageDays: 400, productId: std, stockClass: 'customised' });
    await piece({ sku: 'D-DISPLAY', ageDays: 400, stockClass: 'non_stock' });
    await piece({ sku: 'D-REMAKE', ageDays: 400, productId: std });

    await request(server())
      .patch(`/stock/dead/classification/piece/${ids['D-REMAKE']}`)
      .set(auth(mgrT))
      .send({ remakeSuitable: true })
      .expect(200);

    const view = async (v?: string) =>
      (
        await request(server())
          .get('/stock/dead')
          .query({ storeId: A.store, ...(v ? { view: v } : {}) })
          .set(auth(mgrT))
          .expect(200)
      ).body;

    const skus = (body: { items: { sku: string }[] }) => body.items.map((i) => i.sku).sort();

    const stock = await view();
    expect(stock.view).toBe('stock');
    expect(skus(stock)).toEqual(['D-ORDINARY', 'D-REMAKE']);
    expect(stock.items.find((i: { sku: string }) => i.sku === 'D-ORDINARY').suggestion).toBe('sell');
    expect(stock.items.find((i: { sku: string }) => i.sku === 'D-REMAKE').suggestion).toBe('remake');

    const customised = await view('customised');
    expect(skus(customised)).toEqual(['D-CUSTOM-INHERIT', 'D-CUSTOM-OWN']);
    for (const row of customised.items) {
      // Never "sell" — it is somebody's order.
      expect(row.suggestion).toBe('contact_customer');
    }
    expect(customised.items.find((i: { sku: string }) => i.sku === 'D-CUSTOM-INHERIT').stockClassSource).toBe(
      'design',
    );
    expect(customised.items.find((i: { sku: string }) => i.sku === 'D-CUSTOM-OWN').stockClassSource).toBe(
      'piece',
    );

    expect(skus(await view('remake'))).toEqual(['D-REMAKE']);

    const excluded = await view('excluded');
    expect(skus(excluded)).toEqual(['D-DISPLAY']);
    expect(excluded.items[0].suggestion).toBeNull();

    expect(stock.buckets).toEqual({ stock: 2, customised: 2, remake: 1, excluded: 1 });
    expect(customised.buckets).toEqual(stock.buckets);

    // The summary's dead-stock figure is ordinary merchandise only.
    const summary = await request(server())
      .get('/stock/summary')
      .set(auth(mgrT))
      .set('X-Store-Id', A.store)
      .expect(200);
    expect(summary.body.deadStock).toBe(stock.dead);
  });

  it('a customised piece that is marked for remaking stops being "contact the customer"', async () => {
    await request(server())
      .patch(`/stock/dead/classification/piece/${ids['D-CUSTOM-OWN']}`)
      .set(auth(mgrT))
      .send({ remakeSuitable: true })
      .expect(200);
    const remake = await request(server())
      .get('/stock/dead')
      .query({ storeId: A.store, view: 'remake' })
      .set(auth(mgrT))
      .expect(200);
    const row = remake.body.items.find((i: { sku: string }) => i.sku === 'D-CUSTOM-OWN');
    expect(row.suggestion).toBe('remake');
    // And it is still customised — the flag does not reclassify it.
    expect(row.stockClass).toBe('customised');
  });

  it('clearing a piece classification returns it to its design', async () => {
    const res = await request(server())
      .patch(`/stock/dead/classification/piece/${ids['D-CUSTOM-OWN']}`)
      .set(auth(mgrT))
      .send({ stockClass: null })
      .expect(200);
    expect(res.body).toMatchObject({ stockClass: 'standard', stockClassSource: 'design', remakeSuitable: true });
  });

  it('a design classification is head office only, and every inheriting piece follows', async () => {
    const product = await prisma.product.findFirst({ where: { organisationId: A.org, sku: 'DEAD-STD' } });
    await request(server())
      .patch(`/stock/dead/classification/product/${product!.id}`)
      .set(auth(mgrT))
      .send({ stockClass: 'non_stock' })
      .expect(403);
    await request(server())
      .patch(`/stock/dead/classification/product/${product!.id}`)
      .set(auth(hoT))
      .send({ stockClass: 'non_stock' })
      .expect(200);

    const excluded = await request(server())
      .get('/stock/dead')
      .query({ storeId: A.store, view: 'excluded' })
      .set(auth(hoT))
      .expect(200);
    expect(excluded.body.items.map((i: { sku: string }) => i.sku)).toEqual(
      expect.arrayContaining(['D-ORDINARY', 'D-REMAKE', 'D-DISPLAY']),
    );

    // Put it back for the tests that follow.
    await request(server())
      .patch(`/stock/dead/classification/product/${product!.id}`)
      .set(auth(hoT))
      .send({ stockClass: 'standard' })
      .expect(200);
  });

  it('classification is refused outside scope, for a salesperson, and for nonsense', async () => {
    const far = await piece({ sku: 'FAR-1', ageDays: 10, storeId: A.far });
    await request(server())
      .patch(`/stock/dead/classification/piece/${far}`)
      .set(auth(mgrT))
      .send({ stockClass: 'customised' })
      .expect(403);
    await request(server())
      .patch(`/stock/dead/classification/piece/${ids['D-ORDINARY']}`)
      .set(auth(repT))
      .send({ stockClass: 'customised' })
      .expect(403);
    await request(server())
      .patch(`/stock/dead/classification/piece/${ids['D-ORDINARY']}`)
      .set(auth(mgrT))
      .send({ stockClass: 'sellable' })
      .expect(400);
    // Another tenant's head office cannot see the piece exists.
    await request(server())
      .patch(`/stock/dead/classification/piece/${ids['D-ORDINARY']}`)
      .set(auth(otherHoT))
      .send({ stockClass: 'customised' })
      .expect(404);
    await request(server()).get('/stock/dead').query({ view: 'bogus' }).set(auth(mgrT)).expect(400);
  });

  it('the dead-stock export carries the classification', async () => {
    const res = await request(server())
      .get('/stock/dead/export.xlsx')
      .query({ storeId: A.store, view: 'all' })
      .set(auth(mgrT))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);

    const wb = new Workbook();
    await wb.xlsx.load(res.body as never);
    const ws = wb.getWorksheet('Dead stock')!;
    const header = (ws.getRow(1).values as unknown[]).slice(1);
    expect(header).toEqual(expect.arrayContaining(['Classification', 'Suitable for remaking', 'Suggested action']));

    const col = (name: string) => header.indexOf(name) + 1;
    const rows: Record<string, string> = {};
    ws.eachRow((row, n) => {
      if (n === 1) return;
      rows[String(row.getCell(col('SKU')).value)] = String(row.getCell(col('Classification')).value);
    });
    expect(rows['D-DISPLAY']).toBe('Non-stock (display / sample)');
    expect(rows['D-CUSTOM-INHERIT']).toBe('Customised / made to order');
    expect(rows['D-ORDINARY']).toBe('Standard stock');
    expect(Number(res.headers['x-export-rows'])).toBe(Object.keys(rows).length);

    // Salespeople see the screen, not the file.
    await request(server()).get('/stock/dead/export.xlsx').set(auth(repT)).expect(403);

    const audit = await prisma.auditLog.findFirst({
      where: { organisationId: A.org, action: 'stock.dead_stock_exported' },
    });
    expect(audit?.actorId).toBe('u_sc_mgr');
  });

  it('with no policy a tenant keeps the platform default — the 90 days is Eclat’s alone', async () => {
    const policy = await request(server()).get('/stock/dead/policy').set(auth(hoT)).expect(200);
    expect(policy.body.usingPlatformDefault).toBe(true);
    expect(policy.body.defaultThresholdDays).toBe(180);

    // On a seeded database (the default isolated run), the demo tenant carries
    // its own 90-day rule. Skipped under SEED=0, where there is no Eclat tenant.
    const eclat = await prisma.organisation.findUnique({ where: { id: 'org_eclat' } });
    if (eclat) {
      const rule = await prisma.deadStockPolicy.findFirst({
        where: { organisationId: 'org_eclat', category: null },
      });
      expect(rule?.thresholdDays).toBe(90);
    }
  });
});
