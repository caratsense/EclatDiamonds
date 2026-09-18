import { INestApplication, ValidationPipe } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IS_PUBLIC_KEY } from '../src/auth/public.decorator';
import { CatalogueIndexService } from '../src/products/catalogue-index.service';
import { StorageService } from '../src/storage/storage.service';
import { applyImageOrder } from '../src/catalogue/image-order';
import { gatiComposition } from '../src/products/composition';
import { costTier, stripCostJson } from '../src/products/cost-boundary';

/**
 * Product API for the lossless catalogue (docs/modules/05-catalogue-sources.md,
 * "Product API"): list card fields + filters, the lazy detail, the cost
 * boundary by role, pin/unpin, upload → index queue, and tenant/store isolation.
 * Every fixture is synthetic and created here.
 */

// ------------------------------------------------------------ pure (no app)
describe('cost boundary — pure', () => {
  it('maps roles to tiers', () => {
    expect(costTier('salesperson')).toBe('none');
    expect(costTier('storeperson')).toBe('none');
    expect(costTier(undefined)).toBe('none');
    expect(costTier('store_manager')).toBe('amounts');
    expect(costTier('area_manager')).toBe('amounts');
    expect(costTier('head_office')).toBe('full');
  });

  it('strips cost keys at any depth, and raw-material ids below head office', () => {
    const bom = [{ materialName: 'Gold', weight: 2, rate: 6000, lineTotal: 12000, rawMaterialId: 'RM', nested: { amount: 1, pieces: 3 } }];
    expect(stripCostJson(bom, 'full')).toEqual(bom);
    expect(stripCostJson(bom, 'amounts')).toEqual([
      { materialName: 'Gold', weight: 2, rate: 6000, lineTotal: 12000, nested: { amount: 1, pieces: 3 } },
    ]);
    expect(stripCostJson(bom, 'none')).toEqual([{ materialName: 'Gold', weight: 2, nested: { pieces: 3 } }]);
    expect(stripCostJson(null, 'none')).toBeNull();
  });
});

// ------------------------------------------------------------------- API
const PASSWORD = 'password123';
const A = { org: 'org_catapi_a', s1: 'store_catapi_1', s2: 'store_catapi_2' };
const B = { org: 'org_catapi_b', s1: 'store_catapi_b1' };
const P1 = 'catapi_p1'; // Gati + website, the full picture
const P2 = 'catapi_p2'; // website-only, no pictures
const P3 = 'catapi_p3'; // manual, owned by store 2
const P4 = 'catapi_p4'; // manual, one un-indexed upload
const PB = 'catapi_pb'; // another organisation's
const IMG = { cad: 'catapi_img_cad', w1: 'catapi_img_w1', w2: 'catapi_img_w2', p4: 'catapi_img_p4', b: 'catapi_img_b' };
const MINE = new Set([P1, P2, P3, P4]);

/** Keys that must never reach a viewer below store manager. */
// (`amount` is also a selling price's key in `prices`, so composition amounts are checked on their own.)
const COST_KEYS = [
  'marginPercentage', 'makingCharge', 'priceWithMargin', 'rawMaterialId', 'rate', 'lineTotal',
  'cost', 'costPrice', 'metalAmount', 'diamondAmount', 'stoneAmount', 'makingAmount', 'cpfAmount',
];

function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      allKeys(x, out);
    }
  }
  return out;
}

async function teardown(prisma: PrismaService) {
  for (const org of [A.org, B.org]) {
    await prisma.catalogueConflict.deleteMany({ where: { organisationId: org } });
    await prisma.productEmbedding.deleteMany({ where: { productId: { in: [P1, P2, P3, P4, PB] } } });
    await prisma.stockItem.deleteMany({ where: { organisationId: org } });
    await prisma.product.deleteMany({ where: { organisationId: org } }); // cascades catalogue rows
    await prisma.auditLog.deleteMany({ where: { organisationId: org } });
    await prisma.userStore.deleteMany({ where: { user: { organisationId: org } } });
    await prisma.user.deleteMany({ where: { organisationId: org } });
    await prisma.store.deleteMany({ where: { organisationId: org } });
    await prisma.organisation.deleteMany({ where: { id: org } });
  }
}

describe('Catalogue product API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let enqueue: jest.SpyInstance;
  const t: Record<string, string> = {};
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
  const V14 = 'catapi_v14';
  const V18 = 'catapi_v18';

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    // Never write real files or queue real jobs from a test.
    jest.spyOn(app.get(StorageService), 'save').mockImplementation(async (_o, _f, name) => `/uploads/test/${name}`);
    enqueue = jest.spyOn(app.get(CatalogueIndexService), 'enqueue').mockResolvedValue(1);
    await teardown(prisma);

    await prisma.organisation.create({ data: { id: A.org, name: 'CatApi A', slug: 'catapi-a', industryPackCode: 'jewellery' } });
    await prisma.organisation.create({ data: { id: B.org, name: 'CatApi B', slug: 'catapi-b', industryPackCode: 'jewellery' } });
    await prisma.store.createMany({
      data: [
        { id: A.s1, name: 'A One', city: 'Mumbai', organisationId: A.org },
        { id: A.s2, name: 'A Two', city: 'Pune', organisationId: A.org },
        { id: B.s1, name: 'B One', city: 'Delhi', organisationId: B.org },
      ],
    });
    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const [id, role, org, stores] of [
      ['catapi_ho', 'head_office', A.org, [A.s1, A.s2]],
      ['catapi_am', 'area_manager', A.org, [A.s1, A.s2]],
      ['catapi_sm', 'store_manager', A.org, [A.s1]],
      ['catapi_rep', 'salesperson', A.org, [A.s1]],
      ['catapi_hob', 'head_office', B.org, [B.s1]],
    ] as const) {
      await prisma.user.create({
        data: {
          id, email: `${id}@catapi.local`, name: id, role: role as Role, passwordHash: hash, isActive: true,
          approvalStatus: 'approved', organisationId: org,
          userStores: { create: stores.map((storeId, i) => ({ storeId, isPrimary: i === 0 })) },
        },
      });
      t[id] = (await request(server()).post('/auth/login').send({ email: `${id}@catapi.local`, password: PASSWORD }).expect(201)).body.token;
    }

    // --- P1: a Gati design that is also on the website ---------------------
    await prisma.product.create({
      data: {
        id: P1, organisationId: A.org, sku: 'CATAPI-SKU-1', name: 'CATAPI-11871RG', legacyId: 'CATAPI-G1',
        websiteCode: '11871RG', category: 'ring', metal: 'gold_18k', karat: 18, price: 50000, costPrice: 31000,
        hsn: '7113', gatiSyncedAt: new Date('2026-09-10T00:00:00Z'), websiteSyncedAt: new Date('2026-09-11T00:00:00Z'),
        composition: gatiComposition({ NetWt: 2, TotMtlAmt: 22748.7, TotDiaWt: 0.3, TotDiaAmt: 15000, TotHandlingAmt: 3500 }, 'gold_18k') as object,
        websiteListing: {
          create: {
            organisationId: A.org, externalId: 'ext-fake-1', productCode: '11871RG', marketingName: 'Catapi Aurora Ring',
            categories: ['Rings'], subCategories: ['Solitaire'], tags: ['bridal'], specifications: 'Gold 18KT: 8.07 g',
          },
        },
      },
    });
    await prisma.productVariant.createMany({
      data: [
        {
          id: V14, organisationId: A.org, productId: P1, source: 'website', sourceKey: 'rose|14|lab', karat: 14,
          metal: 'gold_14k', metalType: 'Rose Gold', colour: 'Rose', diamondType: 'Lab', goldWeight: 2.1,
          price: 40000, priceWithMargin: 46000, marginPercentage: 15, makingCharge: 3000,
          bom: [
            { materialName: 'Gold 14k', weight: 2.1, unit: 'gram', rate: 6000, lineTotal: 12600, rawMaterialId: 'RM-FAKE-1' },
            { materialName: 'Diamond', weight: 0.3, unit: 'gram', rate: 50000, lineTotal: 15000, rawMaterialId: 'RM-FAKE-2', isDiamond: true },
          ],
        },
        { id: V18, organisationId: A.org, productId: P1, source: 'website', sourceKey: 'yellow|18|lab', karat: 18, metal: 'gold_18k', metalType: 'Yellow Gold', colour: 'Yellow', price: 55000 },
      ],
    });
    await prisma.productOption.createMany({
      data: ['IND 12', 'IND 14'].map((value, i) => ({ organisationId: A.org, productId: P1, source: 'website', kind: 'size', value, sortOrder: i })),
    });
    await prisma.productPrice.createMany({
      data: [
        { kind: 'min_variant', amount: 40000 },
        { kind: 'variant', amount: 40000, variantKey: V14 },
        { kind: 'variant', amount: 55000, variantKey: V18 },
        { kind: 'variant_with_margin', amount: 46000, variantKey: V14 },
        { kind: 'indicative', amount: 45000 },
        { kind: 'gati_tag_min', amount: 52000, source: 'gati' },
        { kind: 'gati_tag_max', amount: 58000, source: 'gati' },
      ].map((p) => ({ organisationId: A.org, productId: P1, source: 'website', ...p })),
    });
    await prisma.productImage.createMany({
      data: [
        { id: IMG.cad, url: 'https://example.com/cad.jpg', source: 'gati_cad', embeddingStatus: 'indexed' },
        { id: IMG.w1, url: 'https://example.com/w1.jpg', thumbUrl: 'https://example.com/w1-t.webp', source: 'website', sourceOrder: 0, embeddingStatus: 'indexed' },
        { id: IMG.w2, url: 'https://example.com/w2.jpg', source: 'website', sourceOrder: 1 },
      ].map((i) => ({ organisationId: A.org, productId: P1, ...i })),
    });
    await prisma.productImageAssociation.create({
      data: { organisationId: A.org, imageId: IMG.w1, variantId: V14, source: 'website', colour: 'Rose', shape: 'Round', angle: 'front' },
    });
    await applyImageOrder(prisma, P1);
    await prisma.catalogueConflict.create({
      data: {
        organisationId: A.org, kind: 'spec_mismatch', key: 'catapi-p1', productId: P1, summary: 'Spec 8.07 g vs BOM 8.70 g',
        detail: { specWeight: 8.07, bomWeight: 8.7, rate: 999 },
      },
    });
    await prisma.stockItem.createMany({
      data: [
        {
          id: 'catapi_piece_1', organisationId: A.org, storeId: A.s1, productId: P1, sku: 'CATAPI-SKU-1', legacyId: 'J-1001',
          status: 'in_stock', sizeLabel: 'IND 12', hsn: '7113', huid: 'AB12CD', hallmarkNo: 'HM-1', certificateNo: 'IGI-1',
          grossWeight: 2.5, netWeight: 2.1, pureWeight: 1.575, diamondWeightCt: 0.3, diamondPieces: 12, stonePieces: 2,
          metalAmount: 20000, diamondAmount: 15000, makingAmount: 3000, cpfAmount: 100, cost: 38100, tagPrice: 52000, mrp: 52000,
          variantId: V14,
        },
        { id: 'catapi_piece_2', organisationId: A.org, storeId: A.s2, productId: P1, legacyId: 'J-1002', status: 'in_stock', cost: 41000, tagPrice: 58000 },
      ],
    });

    // --- P2: website only ---------------------------------------------------
    await prisma.product.create({
      data: {
        id: P2, organisationId: A.org, sku: 'WEB-CATAPI2', name: 'Catapi Web Only', legacyId: 'WEB-CATAPI2', websiteCode: 'CATAPI2',
        category: 'earrings', metal: 'gold_9k', availability: 'lead_time',
        websiteListing: { create: { organisationId: A.org, externalId: 'ext-fake-2', productCode: 'CATAPI2', marketingName: 'Catapi Web Only', categories: ['Earrings'] } },
        variants: { create: { organisationId: A.org, source: 'website', sourceKey: 'white|9', karat: 9, colour: 'White', metalType: 'White Gold' } },
      },
    });
    // --- P3: store 2 only; P4: one manual photo, not indexed yet --------------
    await prisma.product.create({ data: { id: P3, organisationId: A.org, sku: 'CATAPI-S2', name: 'CATAPI-S2-ONLY', metal: 'silver', storeId: A.s2 } });
    await prisma.product.create({ data: { id: P4, organisationId: A.org, sku: 'CATAPI-M4', name: 'CATAPI-MANUAL', metal: 'gold_22k', imageUrl: '/uploads/p4.jpg' } });
    await prisma.productImage.create({ data: { id: IMG.p4, organisationId: A.org, productId: P4, url: '/uploads/p4.jpg', source: 'manual', isPrimary: true } });
    // --- another organisation --------------------------------------------------
    await prisma.product.create({ data: { id: PB, organisationId: B.org, sku: 'CATAPI-B', name: 'CATAPI-B-RING', metal: 'gold_18k' } });
    await prisma.productImage.create({ data: { id: IMG.b, organisationId: B.org, productId: PB, url: 'https://example.com/b.jpg', source: 'manual' } });
  }, 120_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    await app?.close();
  });

  const list = (who: string, qs = '') =>
    request(server()).get(`/products?page=1&pageSize=100&q=catapi${qs}`).set(as(who));
  const ids = async (who: string, qs: string) => {
    const res = await list(who, qs).expect(200);
    return (res.body.items as { id: string }[]).map((i) => i.id).filter((id) => MINE.has(id)).sort();
  };

  // ---------------------------------------------------------------- list
  it('adds the card fields in batch, CAD first', async () => {
    const res = await list('catapi_ho').expect(200);
    const p1 = res.body.items.find((i: { id: string }) => i.id === P1);
    expect(p1).toMatchObject({
      displayName: 'Catapi Aurora Ring',
      name: 'CATAPI-11871RG',
      heroImageUrl: 'https://example.com/cad.jpg',
      heroSource: 'gati_cad',
      heroThumbUrl: null,
      onlinePrice: { min: 40000, max: 55000, indicative: 45000 },
      tagPrice: { min: 52000, max: 58000 },
      onHand: 2,
      flags: { noImage: false, noCad: false, conflicts: 1, indexing: 'partial' },
    });
    const p2 = res.body.items.find((i: { id: string }) => i.id === P2);
    expect(p2).toMatchObject({
      displayName: 'Catapi Web Only',
      heroImageUrl: null,
      onlinePrice: null,
      tagPrice: null,
      onHand: 0,
      flags: { noImage: true, noCad: true, conflicts: 0, indexing: 'none' },
    });
    const p4 = res.body.items.find((i: { id: string }) => i.id === P4);
    expect(p4).toMatchObject({ heroSource: 'manual', flags: { noImage: false, noCad: true, indexing: 'none' } });
  });

  it.each([
    ['&category=Rings', [P1]],
    ['&category=ring', [P1]],
    ['&subCategory=Solitaire', [P1]],
    ['&size=ind%2012', [P1]],
    ['&karat=9', [P2]],
    ['&colour=rose', [P1]],
    ['&priceMin=50000&priceMax=53000', [P1]],
    ['&priceMax=1000', []],
    ['&availability=lead_time', [P2]],
    ['&source=website', [P2]],
    ['&source=gati_website', [P1]],
    ['&source=manual', [P3, P4]],
    ['&imageCoverage=none', [P2, P3]],
    ['&imageCoverage=no_cad', [P2, P3, P4]],
    ['&imageCoverage=unindexed', [P4]],
    ['&imageCoverage=indexed', [P1]],
    ['&storeId=' + A.s1, [P1, P2, P4]],
    ['&storeId=' + A.s2, [P1, P2, P3, P4]],
  ])('filters server-side: %s', async (qs, expected) => {
    expect(await ids('catapi_ho', qs)).toEqual([...expected].sort());
  });

  it('rejects a filter value it does not know, rather than ignoring it', async () => {
    await list('catapi_ho', '&imageCoverage=everything').expect(400);
    await list('catapi_ho', '&karat=abc').expect(400);
    await list('catapi_ho', '&source=ebay').expect(400);
  });

  it('keeps the style-number exact match first, and still finds by marketing name', async () => {
    const res = await request(server()).get('/products?page=1&pageSize=10&q=catapi-11871rg').set(as('catapi_rep')).expect(200);
    expect(res.body.items[0].id).toBe(P1);
    const byName = await request(server()).get('/products?page=1&pageSize=10&q=aurora').set(as('catapi_rep')).expect(200);
    expect(byName.body.items.map((i: { id: string }) => i.id)).toEqual([P1]);
  });

  // -------------------------------------------------------------- detail
  it('head office sees the whole design, including cost and raw-material ids', async () => {
    const res = await request(server()).get(`/products/${P1}/full`).set(as('catapi_ho')).expect(200);
    const b = res.body;
    expect(b.identifiers).toEqual({
      gatiId: 'CATAPI-G1', sku: 'CATAPI-SKU-1', styleNumber: 'CATAPI-11871RG', websiteCode: '11871RG',
      externalId: 'ext-fake-1', websiteProductCode: '11871RG', hsn: '7113',
    });
    expect(b.displayName).toBe('Catapi Aurora Ring');
    expect(b.listing).toMatchObject({ marketingName: 'Catapi Aurora Ring', categories: ['Rings'], subCategories: ['Solitaire'], tags: ['bridal'] });
    expect(b.specifications).toMatchObject({ text: 'Gold 18KT: 8.07 g', source: 'website' });
    expect(b.sizes.map((s: { value: string }) => s.value)).toEqual(['IND 12', 'IND 14']);
    const v14 = b.variants.find((v: { id: string }) => v.id === V14);
    expect(v14).toMatchObject({ karat: 14, colour: 'Rose', price: 40000, priceWithMargin: 46000, marginPercentage: 15, makingCharge: 3000 });
    expect(v14.bom[0]).toMatchObject({ rate: 6000, lineTotal: 12600, rawMaterialId: 'RM-FAKE-1' });
    expect(b.prices.map((p: { kind: string }) => p.kind)).toContain('variant_with_margin');
    const v18price = b.prices.find((p: { kind: string; amount: number }) => p.kind === 'variant' && p.amount === 55000);
    expect(v18price).toMatchObject({ source: 'website', variantId: V18, label: 'Variant price (website)' });
    expect(b.images.map((i: { id: string }) => i.id)).toEqual([IMG.cad, IMG.w1, IMG.w2]);
    expect(b.images[0]).toMatchObject({ source: 'gati_cad', isPrimary: true, pinned: false, embeddingStatus: 'indexed' });
    expect(b.images[1]).toMatchObject({ colour: 'Rose', shape: 'Round', angle: 'front', thumbUrl: 'https://example.com/w1-t.webp' });
    expect(b.pieces).toHaveLength(2);
    const piece = b.pieces.find((p: { id: string }) => p.id === 'catapi_piece_1');
    expect(piece).toMatchObject({
      tagNo: 'J-1001', sizeLabel: 'IND 12', hsn: '7113', huid: 'AB12CD', hallmarkNo: 'HM-1', certificateNo: 'IGI-1',
      grossWeight: 2.5, netWeight: 2.1, pureWeight: 1.575, diamondWeightCt: 0.3, diamondPieces: 12, stonePieces: 2,
      tagPrice: 52000, metalAmount: 20000, diamondAmount: 15000, makingAmount: 3000, cpfAmount: 100, cost: 38100,
      variantId: V14, storeName: 'A One',
    });
    expect(b.costPrice).toBe(31000);
    expect(b.availabilityByStore.map((s: { storeId: string }) => s.storeId).sort()).toEqual([A.s1, A.s2]);
    expect(b.provenance).toMatchObject({ source: 'gati_website', gatiSyncedAt: '2026-09-10T00:00:00.000Z', websiteSyncedAt: '2026-09-11T00:00:00.000Z' });
    expect(b.conflicts).toEqual([expect.objectContaining({ kind: 'spec_mismatch', detail: { specWeight: 8.07, bomWeight: 8.7, rate: 999 } })]);
  });

  it.each(['catapi_sm', 'catapi_am'])('%s sees amounts and margins, never raw-material ids', async (who) => {
    const res = await request(server()).get(`/products/${P1}/full`).set(as(who)).expect(200);
    const v14 = res.body.variants.find((v: { id: string }) => v.id === V14);
    expect(v14).toMatchObject({ marginPercentage: 15, makingCharge: 3000, priceWithMargin: 46000 });
    expect(v14.bom[0]).toMatchObject({ rate: 6000, lineTotal: 12600 });
    expect(allKeys(res.body).has('rawMaterialId')).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('RM-FAKE');
    expect(res.body.pieces.find((p: { id: string }) => p.id === 'catapi_piece_1')).toMatchObject({ cost: 38100, metalAmount: 20000 });
    expect(res.body.composition.lines[0].amount).toBe(22748.7);
  });

  it('a store manager sees only the pieces in their own stores', async () => {
    const res = await request(server()).get(`/products/${P1}/full`).set(as('catapi_sm')).expect(200);
    expect(res.body.pieces.map((p: { id: string }) => p.id)).toEqual(['catapi_piece_1']);
  });

  it('a salesperson gets the design with every cost field removed', async () => {
    const res = await request(server()).get(`/products/${P1}/full`).set(as('catapi_rep')).expect(200);
    const keys = allKeys(res.body);
    expect(COST_KEYS.filter((k) => keys.has(k))).toEqual([]);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('RM-FAKE');
    expect(text).not.toContain('variant_with_margin');
    expect(text).not.toContain('22748.7');
    expect(res.body.composition.lines.every((l: object) => !('amount' in l))).toBe(true);
    // …and keeps everything that is the piece itself.
    const v14 = res.body.variants.find((v: { id: string }) => v.id === V14);
    expect(v14).toMatchObject({ price: 40000, goldWeight: 2.1 });
    expect(v14.bom[0]).toEqual({ materialName: 'Gold 14k', weight: 2.1, unit: 'gram' });
    expect(res.body.pieces[0]).toMatchObject({ huid: 'AB12CD', sizeLabel: 'IND 12', tagPrice: 52000, grossWeight: 2.5 });
    expect(res.body.conflicts[0].detail).toEqual({ specWeight: 8.07, bomWeight: 8.7 });
    // The card routes carry no cost either.
    const card = await request(server()).get(`/products/${P1}`).set(as('catapi_rep')).expect(200);
    expect(COST_KEYS.filter((k) => allKeys(card.body).has(k))).toEqual([]);
  });

  it('has no public product or catalogue route, and an anonymous caller gets nothing', async () => {
    const open: string[] = [];
    for (const m of app.get(ModulesContainer).values()) {
      for (const w of m.controllers.values()) {
        const ctor = w.metatype as (new (...a: unknown[]) => unknown) | undefined;
        if (!ctor?.prototype) continue;
        const prefix = String(Reflect.getMetadata(PATH_METADATA, ctor) ?? '');
        if (!/^\/?(products|catalogue)/.test(prefix)) continue;
        const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, ctor) === true;
        for (const name of Object.getOwnPropertyNames(ctor.prototype)) {
          const h = ctor.prototype[name];
          if (typeof h === 'function' && (classPublic || Reflect.getMetadata(IS_PUBLIC_KEY, h) === true)) open.push(`${prefix} ${name}`);
        }
      }
    }
    expect(open).toEqual([]);
    for (const path of [`/products/${P1}/full`, `/products/${P1}`, `/products/${P1}/pieces`, '/products?q=catapi']) {
      const res = await request(server()).get(path).expect(401);
      expect(COST_KEYS.filter((k) => allKeys(res.body).has(k))).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain('RM-FAKE');
    }
  });

  // --------------------------------------------------------- isolation
  it('another organisation cannot see, list or touch a design or its photos', async () => {
    for (const path of [`/products/${P1}/full`, `/products/${P1}`, `/products/${P1}/pieces`, `/products/${P1}/images`]) {
      await request(server()).get(path).set(as('catapi_hob')).expect(404);
    }
    await request(server()).post(`/products/${P1}/images/${IMG.w2}/primary`).set(as('catapi_hob')).expect(404);
    await request(server()).delete(`/products/${P1}/images/${IMG.w2}/primary`).set(as('catapi_hob')).expect(404);
    await request(server()).delete(`/products/${P1}/images/${IMG.w2}`).set(as('catapi_hob')).expect(404);
    const listed = await request(server()).get('/products?page=1&pageSize=100&q=catapi').set(as('catapi_hob')).expect(200);
    expect(listed.body.items.map((i: { id: string }) => i.id)).toEqual([PB]);
    // …and the other way round, including another tenant's photo id under our own design.
    await request(server()).get(`/products/${PB}/full`).set(as('catapi_ho')).expect(404);
    await request(server()).post(`/products/${P1}/images/${IMG.b}/primary`).set(as('catapi_ho')).expect(404);
    expect((await prisma.productImage.findUniqueOrThrow({ where: { id: IMG.b } })).pinnedPrimary).toBe(false);
  });

  it('a design owned by a store outside the viewer\'s scope is not found', async () => {
    await request(server()).get(`/products/${P3}/full`).set(as('catapi_rep')).expect(404);
    await request(server()).get(`/products/${P3}`).set(as('catapi_rep')).expect(404);
    await request(server()).get(`/products/${P3}/images`).set(as('catapi_sm')).expect(404);
    await request(server()).get(`/products/${P3}/full`).set(as('catapi_ho')).expect(200);
    expect(await ids('catapi_rep', '')).not.toContain(P3);
  });

  // ------------------------------------------------------ pin / upload
  it('pinning a photo makes it the hero; unpinning restores CAD first', async () => {
    const pinned = await request(server()).post(`/products/${P1}/images/${IMG.w2}/primary`).set(as('catapi_ho')).expect(201);
    expect(pinned.body[0]).toMatchObject({ id: IMG.w2, isPrimary: true, pinned: true });
    let card = (await list('catapi_ho').expect(200)).body.items.find((i: { id: string }) => i.id === P1);
    expect(card).toMatchObject({ heroImageUrl: 'https://example.com/w2.jpg', heroSource: 'website', imageUrl: 'https://example.com/w2.jpg' });

    // Pinning another clears the first pin — there is only ever one.
    await request(server()).post(`/products/${P1}/images/${IMG.w1}/primary`).set(as('catapi_sm')).expect(201);
    const pins = await prisma.productImage.findMany({ where: { productId: P1, pinnedPrimary: true }, select: { id: true } });
    expect(pins).toEqual([{ id: IMG.w1 }]);

    const unpinned = await request(server()).delete(`/products/${P1}/images/${IMG.w1}/primary`).set(as('catapi_ho')).expect(200);
    expect(unpinned.body.map((i: { id: string }) => i.id)).toEqual([IMG.cad, IMG.w1, IMG.w2]);
    expect(unpinned.body[0]).toMatchObject({ isPrimary: true, pinned: false, source: 'gati_cad' });
    card = (await list('catapi_ho').expect(200)).body.items.find((i: { id: string }) => i.id === P1);
    expect(card).toMatchObject({ heroImageUrl: 'https://example.com/cad.jpg', heroSource: 'gati_cad' });
  });

  it('a salesperson cannot pin', async () => {
    await request(server()).post(`/products/${P1}/images/${IMG.w2}/primary`).set(as('catapi_rep')).expect(403);
  });

  it('an upload is queued for indexing and ordered after CAD and website photos', async () => {
    enqueue.mockClear();
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');
    const res = await request(server())
      .post(`/products/${P1}/images`)
      .set(as('catapi_ho'))
      .field('angles', 'on hand')
      .attach('files', png, { filename: 'hand.png', contentType: 'image/png' })
      .expect(201);
    const added = res.body.find((i: { source: string }) => i.source === 'manual');
    expect(added).toMatchObject({ angle: 'on hand', isPrimary: false, embeddingStatus: 'pending' });
    expect(res.body[0].id).toBe(IMG.cad);
    expect(enqueue).toHaveBeenCalledWith(A.org, [added.id]);

    // The legacy single-photo route queues too.
    enqueue.mockClear();
    const single = await request(server())
      .post(`/products/${P2}/image`)
      .set(as('catapi_ho'))
      .attach('file', png, { filename: 'one.png', contentType: 'image/png' })
      .expect(201);
    // P2 had no photos, so the upload is its cover.
    expect(single.body.imageUrl).toMatch(/^\/uploads\/test\//);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toBe(A.org);

    // Deleting a manual photo removes it; deleting a synced one only tombstones it.
    await request(server()).delete(`/products/${P1}/images/${added.id}`).set(as('catapi_ho')).expect(200);
    expect(await prisma.productImage.findUnique({ where: { id: added.id } })).toBeNull();
    const after = await request(server()).delete(`/products/${P1}/images/${IMG.w2}`).set(as('catapi_ho')).expect(200);
    expect(after.body.map((i: { id: string }) => i.id)).toEqual([IMG.cad, IMG.w1]);
    expect((await prisma.productImage.findUniqueOrThrow({ where: { id: IMG.w2 } })).status).toBe('tombstoned');
  });

  it('a photo is judged by its bytes: other formats become JPEG, an unreadable one is refused', async () => {
    // A TIFF labelled as a PNG: stored as the JPEG every browser can show.
    const tiff = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#b08d57' } }).tiff().toBuffer();
    const res = await request(server())
      .post(`/products/${P1}/images`)
      .set(as('catapi_ho'))
      .attach('files', tiff, { filename: 'scan.png', contentType: 'image/png' })
      .expect(201);
    const stored = res.body.filter((i: { source: string }) => i.source === 'manual').pop();
    expect(stored.url).toMatch(/\.jpg$/);

    // A GIF becomes a JPEG too: the inference service indexes only JPEG/PNG/WebP.
    const gif = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#d4af37' } }).gif().toBuffer();
    const g = await request(server())
      .post(`/products/${P1}/images`)
      .set(as('catapi_ho'))
      .attach('files', gif, { filename: 'spin.gif', contentType: 'image/gif' })
      .expect(201);
    expect(g.body.filter((i: { source: string }) => i.source === 'manual').pop().url).toMatch(/\.jpg$/);

    // An iPhone HEIC from a browser that cannot decode it: refused, with what to do.
    const heic = Buffer.concat([Buffer.from('000000186674797068656963', 'hex'), Buffer.alloc(64)]);
    const before = await prisma.productImage.count({ where: { productId: P1 } });
    const bad = await request(server())
      .post(`/products/${P1}/images`)
      .set(as('catapi_ho'))
      .attach('files', tiff, { filename: 'fine.tif', contentType: 'image/tiff' })
      .attach('files', heic, { filename: 'IMG_0042.HEIC', contentType: 'image/heic' })
      .expect(400);
    expect(bad.body.message).toMatch(/IMG_0042\.HEIC.*JPEG or PNG/);
    // All or nothing: the readable photo in the same batch was not kept either.
    expect(await prisma.productImage.count({ where: { productId: P1 } })).toBe(before);

    // An SVG is a document, not a photo: refused, not rendered.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    await request(server())
      .post(`/products/${P1}/images`)
      .set(as('catapi_ho'))
      .attach('files', svg, { filename: 'logo.png', contentType: 'image/png' })
      .expect(400);
  });
});
