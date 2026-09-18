import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Module 5 — Gati reconciliation (docs/modules/05-catalogue-sources.md).
 *
 * Synthetic Gati payloads through the real machine-auth ingestion routes
 * (/sync/products, /sync/stock, /sync/product-images) prove: every Gati column
 * we map lands where it should; 9KT/14KT map to their own metal (rose tone does
 * not change the enum); the design picture becomes a `gati_cad` image ordered
 * before website photos; website-owned rows are never written; the website
 * variant link is set only when unambiguous; an older agent payload without the
 * new columns leaves them intact; another tenant's rows are untouched.
 */
const PASSWORD = 'password123';
const HO = 'head.office@caratsense.in';
const ORG = 'org_eclat';
const PROFILE_HASH = 'e'.repeat(64);
const SOURCE_INSTANCE_HASH = 'f'.repeat(64);
const RUN = `${Date.now()}`;
const SRC_STORE_ID = `catgati-store-${RUN}`;
const SRC_LEGACY = `CATGATI-BR-${RUN}`;
const B_ORG = `org_catgati_${RUN}`;
const B_STORE = `store_catgati_${RUN}`;

const STYLE_9 = `CATGATI-S9-${RUN}`;
const STYLE_14 = `CATGATI-S14-${RUN}`;
const J = (n: number) => `CATGATI-J${n}-${RUN}`;

describe('Catalogue — Gati reconciliation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let agentToken: string;
  let agentId: string;
  let configRevision: string;
  let p14: string;
  let rose14: string;
  let only18: string;

  const agentHeaders = () => ({
    Authorization: `Bearer ${agentToken}`,
    'x-caratos-profile-id': 'gati-catalogue-reconcile-e2e',
    'x-caratos-profile-hash': PROFILE_HASH,
    'x-caratos-source-instance-hash': SOURCE_INSTANCE_HASH,
    'x-caratos-config-revision': configRevision,
  });
  const post = (route: string, records: Record<string, unknown>[]) =>
    request(app.getHttpServer()).post(`/sync/${route}`).set(agentHeaders()).send({ records });

  const style14 = {
    StyleId: STYLE_14,
    StyleCode: '11871RG',
    StyleSKUNo: '11871RG-G-14KT-PG',
    ToneCode: 'PG',
    GrossWt: 4.2,
    TagPrice: 50000,
    UpdateDate: '2026-09-18T10:00:00.000Z',
  };
  const piece = (n: number, extra: Record<string, unknown> = {}) => ({
    JewelId: J(n),
    StyleId: STYLE_14,
    InwardSKUNo: '11871RG-G-14KT-PG-7',
    JewelCode: `TAG-${n}`,
    Status: 'A',
    EclatBranchId: SRC_LEGACY,
    GrossWt: 4.25,
    NetWt: 3.9,
    PureWt: 2.28,
    TotDiaWt: 0.35,
    TotDiaPc: 18,
    TotCZWt: 0.05,
    TotCZPc: 4,
    TotMtlAmt: 21000,
    TotDiaAmt: 30000,
    TotCZAmt: 800,
    TotHandlingAmt: 4500,
    TotCPFAmt: 300,
    COST: 52000,
    MRP: 61000,
    TagPrice: 60000,
    Jewelry_CertificateNo: 'IGI-LG-12345',
    ProductCode: 'RNG',
    InwardQty: 1,
    ItemSizeId: 42,
    ToneCode: 'PG',
    UpdateDate: '2026-09-18T11:00:00.000Z',
    ...extra,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
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

    const login = await request(app.getHttpServer()).post('/auth/login').send({ email: HO, password: PASSWORD });
    expect(login.status).toBe(201);
    const ho = { Authorization: `Bearer ${login.body.token}` };
    const enrolled = await request(app.getHttpServer())
      .post('/integration/connect/agents')
      .set(ho)
      .send({ name: `CATGATI ${RUN}`, sourceSystem: 'gati' });
    expect(enrolled.status).toBe(201);
    agentToken = enrolled.body.token;
    agentId = enrolled.body.agent.id;
    const configured = await request(app.getHttpServer())
      .post(`/integration/connect/agents/${agentId}/config`)
      .set(ho)
      .send({
        config: { enabled: true, expectedProfileHash: PROFILE_HASH, expectedSourceInstanceHash: SOURCE_INSTANCE_HASH },
      });
    expect(configured.status).toBe(201);
    configRevision = configured.body.config.configRevision;

    await prisma.store.create({
      data: { id: SRC_STORE_ID, name: 'Cat Gati Source', city: 'Testville', legacyId: SRC_LEGACY, organisationId: ORG },
    });

    // Tenant B holds rows with the SAME legacy ids; A's syncs must never reach them.
    await prisma.organisation.create({ data: { id: B_ORG, name: 'Cat Gati B', slug: `catgati-${RUN}` } });
    await prisma.store.create({ data: { id: B_STORE, name: 'B Store', city: 'Elsewhere', organisationId: B_ORG } });
    const bProduct = await prisma.product.create({
      data: {
        organisationId: B_ORG,
        legacyId: STYLE_14,
        sku: `B-${RUN}`,
        name: 'B design',
        metal: 'gold_22k',
        imageUrl: 'https://b.example.com/b.jpg',
      },
    });
    await prisma.stockItem.create({
      data: { organisationId: B_ORG, storeId: B_STORE, productId: bProduct.id, legacyId: J(1), sku: 'B-PIECE', tagPrice: '1' },
    });
  });

  afterAll(async () => {
    if (prisma) {
      const orgs = [ORG, B_ORG];
      await prisma.stockItem.deleteMany({ where: { organisationId: { in: orgs }, legacyId: { contains: `-${RUN}` } } });
      await prisma.product.deleteMany({ where: { organisationId: { in: orgs }, legacyId: { contains: `-${RUN}` } } });
      await prisma.store.deleteMany({ where: { id: { in: [SRC_STORE_ID, B_STORE] } } });
      await prisma.organisation.deleteMany({ where: { id: B_ORG } });
      if (agentId) await prisma.connectAgent.deleteMany({ where: { id: agentId } });
    }
    await app?.close();
  });

  it('maps StyleMst: style number, sync time, and 9KT / 14KT to their own metal', async () => {
    const res = await post('products', [
      style14,
      {
        StyleId: STYLE_9,
        StyleCode: 'CG9001',
        StyleSKUNo: 'CG9001-G-9KT-YG',
        ToneCode: 'YG',
        UpdateDate: '2026-09-18T10:00:00.000Z',
      },
    ]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ received: 2, upserted: 2, skipped: 0 });

    const p = await prisma.product.findUniqueOrThrow({
      where: { organisationId_legacyId: { organisationId: ORG, legacyId: STYLE_14 } },
    });
    p14 = p.id;
    expect(p.styleNumber).toBe('11871RG');
    // Rose tone does not turn a 14KT design into "18K rose gold".
    expect(p.metal).toBe('gold_14k');
    expect(p.karat).toBe(14);
    expect(p.gatiSyncedAt).toBeInstanceOf(Date);

    const p9 = await prisma.product.findUniqueOrThrow({
      where: { organisationId_legacyId: { organisationId: ORG, legacyId: STYLE_9 } },
    });
    expect(p9.metal).toBe('gold_9k');
    expect(p9.karat).toBe(9);
    expect(p9.styleNumber).toBe('CG9001');
  });

  it('seeds website-owned rows for the design (fixture, as the website sync would)', async () => {
    await prisma.productWebsiteListing.create({
      data: { organisationId: ORG, productId: p14, externalId: 'web-1', productCode: '11871RG', marketingName: 'Aurora Ring' },
    });
    const variant = (sourceKey: string, karat: number, colour: string) =>
      prisma.productVariant.create({
        data: { organisationId: ORG, productId: p14, source: 'website', sourceKey, karat, colour, metal: karat === 14 ? 'gold_14k' : 'gold_18k', price: '70000' },
      });
    rose14 = (await variant('v-14-rose', 14, 'Rose Gold')).id;
    await variant('v-14-yellow', 14, 'Yellow Gold');
    only18 = (await variant('v-18-white', 18, 'White Gold')).id;
    for (const [i, url] of ['https://cdn.example.com/w0.jpg', 'https://cdn.example.com/w1.jpg'].entries()) {
      await prisma.productImage.create({
        data: { organisationId: ORG, productId: p14, url, sourceUrl: url, source: 'website', sourceOrder: i },
      });
    }
    await prisma.productImage.create({
      data: { organisationId: ORG, productId: p14, url: 'https://cdn.example.com/manual.jpg', source: 'manual' },
    });
  });

  it('maps Inward + InwardSummary onto the piece, with tag range and store', async () => {
    const res = await post('stock', [
      piece(1),
      piece(2, { TagPrice: 72000 }),
      piece(3, { TagPrice: 99000, Status: 'X' }), // sold: not in the in-stock range
      piece(4, { InwardSKUNo: '11871RG-G-18KT-7', ToneCode: null }),
      piece(5, { ToneCode: null }), // 14KT, no tone: two website 14KT variants
      piece(6, { ToneCode: 'XX' }), // tone we cannot read
    ]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ received: 6, upserted: 6, skipped: 0 });

    const s = await prisma.stockItem.findUniqueOrThrow({
      where: { organisationId_legacyId: { organisationId: ORG, legacyId: J(1) } },
    });
    expect(s).toMatchObject({
      storeId: SRC_STORE_ID,
      productId: p14,
      styleNumber: '11871RG',
      sku: '11871RG-G-14KT-PG-7',
      name: 'TAG-1',
      metal: 'gold_14k',
      karat: 14,
      status: 'in_stock',
      diamondPieces: 18,
      stonePieces: 4,
      productCode: 'RNG',
      quantity: 1,
      itemSizeId: '42',
      certificateNo: 'IGI-LG-12345',
      variantId: rose14,
    });
    const n = (v: unknown) => Number(v);
    expect(n(s.grossWeight)).toBe(4.25);
    expect(n(s.netWeight)).toBe(3.9);
    expect(n(s.pureWeight)).toBe(2.28);
    expect(n(s.diamondWeightCt)).toBe(0.35);
    expect(n(s.stoneWeightCt)).toBe(0.05);
    expect([s.metalAmount, s.diamondAmount, s.stoneAmount, s.makingAmount, s.cpfAmount].map(n)).toEqual([
      21000, 30000, 800, 4500, 300,
    ]);
    expect([s.cost, s.mrp, s.tagPrice].map(n)).toEqual([52000, 61000, 60000]);

    const prices = await prisma.productPrice.findMany({ where: { productId: p14, source: 'gati' } });
    expect(Object.fromEntries(prices.map((p) => [p.kind, Number(p.amount)]))).toEqual({
      gati_tag_min: 60000,
      gati_tag_max: 72000,
    });
  });

  it('links a piece to a website variant only when exactly one matches', async () => {
    const variantOf = async (n: number) =>
      (
        await prisma.stockItem.findUniqueOrThrow({
          where: { organisationId_legacyId: { organisationId: ORG, legacyId: J(n) } },
          select: { variantId: true, metal: true },
        })
      );
    expect((await variantOf(1)).variantId).toBe(rose14); // 14KT + rose tone
    const p4 = await variantOf(4);
    expect(p4.variantId).toBe(only18); // the only 18KT variant
    expect(p4.metal).toBe('gold_18k');
    expect((await variantOf(5)).variantId).toBeNull(); // 14KT rose vs yellow: ambiguous
    expect((await variantOf(6)).variantId).toBeNull(); // unreadable tone
  });

  it('an older agent payload without the new columns leaves them intact', async () => {
    const old = piece(1, { TagPrice: 65000 }) as Record<string, unknown>;
    for (const col of ['ProductCode', 'InwardQty', 'ItemSizeId', 'TotCZPc']) delete old[col];
    expect((await post('stock', [old])).status).toBe(201);
    const s = await prisma.stockItem.findUniqueOrThrow({
      where: { organisationId_legacyId: { organisationId: ORG, legacyId: J(1) } },
    });
    expect(s).toMatchObject({ productCode: 'RNG', quantity: 1, itemSizeId: '42', stonePieces: 4, styleNumber: '11871RG' });
    expect(Number(s.tagPrice)).toBe(65000);

    const { StyleCode: _drop, ...oldStyle } = style14;
    void _drop;
    expect((await post('products', [oldStyle])).status).toBe(201);
    const p = await prisma.product.findUniqueOrThrow({ where: { id: p14 } });
    expect(p.styleNumber).toBe('11871RG');
  });

  it('the range follows the pieces: a sold piece leaves it', async () => {
    expect((await post('stock', [piece(2, { TagPrice: 72000, Status: 'X' })])).status).toBe(201);
    const prices = await prisma.productPrice.findMany({ where: { productId: p14, source: 'gati' } });
    expect(Object.fromEntries(prices.map((p) => [p.kind, Number(p.amount)]))).toEqual({
      gati_tag_min: 60000, // piece 4 (18KT, 60000) + piece 1 (65000) + 5, 6 (60000)
      gati_tag_max: 65000,
    });
  });

  it('registers the design picture as the gati_cad image, ahead of website photos', async () => {
    const cadUrl = 'https://r2.example.com/cad/11871RG.jpg';
    const send = (url: string) => post('product-images', [{ legacyId: STYLE_14, imageUrl: url, kind: 'product' }]);
    expect((await send(cadUrl)).body).toMatchObject({ received: 1, upserted: 1, skipped: 0 });
    expect((await send(cadUrl)).status).toBe(201); // same URL again: no duplicate

    const images = await prisma.productImage.findMany({ where: { productId: p14 }, orderBy: { sortOrder: 'asc' } });
    const active = images.filter((i) => i.status === 'active');
    expect(active.map((i) => i.source)).toEqual(['gati_cad', 'website', 'website', 'manual']);
    expect(active[0]).toMatchObject({ url: cadUrl, sourceUrl: cadUrl, isPrimary: true, sortOrder: 0 });
    expect(active.filter((i) => i.isPrimary)).toHaveLength(1);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p14 } })).imageUrl).toBe(cadUrl);

    // A new design picture retires the old CAD (tombstone, not delete); manual stays.
    const next = 'https://r2.example.com/cad/11871RG-v2.jpg';
    expect((await send(next)).status).toBe(201);
    const after = await prisma.productImage.findMany({ where: { productId: p14 } });
    const cads = new Map(after.filter((i) => i.source === 'gati_cad').map((i) => [i.sourceUrl, i.status]));
    expect(cads).toEqual(
      new Map([
        [cadUrl, 'tombstoned'],
        [next, 'active'],
      ]),
    );
    expect(after.find((i) => i.source === 'manual')?.status).toBe('active');
    expect(after.find((i) => i.isPrimary)?.url).toBe(next);
  });

  it('a Gati sync never writes website-owned rows', async () => {
    const snapshot = async () => ({
      listing: await prisma.productWebsiteListing.findUniqueOrThrow({ where: { productId: p14 } }),
      variants: await prisma.productVariant.findMany({ where: { productId: p14 }, orderBy: { sourceKey: 'asc' } }),
      webImages: await prisma.productImage.findMany({
        where: { productId: p14, source: 'website' },
        select: { id: true, url: true, sourceUrl: true, status: true, sourceOrder: true },
        orderBy: { sourceOrder: 'asc' },
      }),
    });
    const before = await snapshot();
    expect((await post('products', [style14])).status).toBe(201);
    expect((await post('stock', [piece(1)])).status).toBe(201);
    expect(await snapshot()).toEqual(before);
    expect(before.listing.marketingName).toBe('Aurora Ring');
  });

  it("never touches another tenant's rows with the same legacy ids", async () => {
    const bProduct = await prisma.product.findUniqueOrThrow({
      where: { organisationId_legacyId: { organisationId: B_ORG, legacyId: STYLE_14 } },
      include: { images: true, prices: true },
    });
    expect(bProduct).toMatchObject({ metal: 'gold_22k', styleNumber: null, gatiSyncedAt: null, imageUrl: 'https://b.example.com/b.jpg' });
    expect(bProduct.images).toHaveLength(0);
    expect(bProduct.prices).toHaveLength(0);
    const bPiece = await prisma.stockItem.findUniqueOrThrow({
      where: { organisationId_legacyId: { organisationId: B_ORG, legacyId: J(1) } },
    });
    expect(bPiece).toMatchObject({ storeId: B_STORE, sku: 'B-PIECE', productCode: null, variantId: null, styleNumber: null });
    expect(Number(bPiece.tagPrice)).toBe(1);
  });
});
