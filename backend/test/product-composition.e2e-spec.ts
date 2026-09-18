import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { forViewer, gatiComposition, websiteComposition } from '../src/products/composition';

// ------------------------------------------------------------ pure (no app)
describe('design composition — building it', () => {
  it('reads the Gati summary totals a StyleMst row carries', () => {
    const c = gatiComposition(
      { NetWt: '1.95', GrossWt: '2.23', TotDiaWt: 0.38, TotDiaPc: 52, TotDiaAmt: 15200, TotMtlAmt: 22748.7, TotHandlingAmt: 3500, TotCZWt: 0 },
      'gold_18k',
    );
    expect(c).toEqual({
      source: 'gati',
      lines: [
        { item: 'Gold 18K', kind: 'metal', weight: 1.95, unit: 'g', amount: 22748.7 },
        { item: 'Diamonds', kind: 'diamond', weight: 0.38, unit: 'ct', pieces: 52, amount: 15200 },
        { item: 'Making charges', kind: 'labour', amount: 3500 },
      ],
    });
  });

  it('is null for a row with no summary, so a sync never wipes a stored one', () => {
    expect(gatiComposition({ StyleCode: 'X' }, 'gold_18k')).toBeNull();
  });

  it('reads the website billOfMaterial', () => {
    const c = websiteComposition([
      { materialName: 'Gold 18k', weight: 1.95, unit: 'gram', quantity: 1, rate: 11666, lineTotal: 22748.7, isDiamond: false },
      { materialName: 'Diamond R2-09', weight: 0.04, unit: 'gram', quantity: 12, rate: 20000, lineTotal: 800, isDiamond: true },
      { materialName: '', weight: 1 },
    ]);
    expect(c?.lines).toEqual([
      { item: 'Gold 18k', kind: 'metal', weight: 1.95, unit: 'g', rate: 11666, amount: 22748.7 },
      // Labelled "gram" by the feed; carats in fact (see websiteComposition).
      { item: 'Diamond R2-09', kind: 'diamond', weight: 0.04, unit: 'ct', pieces: 12, rate: 20000, amount: 800 },
    ]);
    expect(websiteComposition(null)).toBeNull();
  });

  it('strips rates, amounts and making for viewers below store manager', () => {
    const full = gatiComposition({ NetWt: 2, TotMtlAmt: 20000, TotDiaWt: 0.5, TotDiaAmt: 9000, TotHandlingAmt: 3000 }, 'gold_14k');
    expect(forViewer(full, true)).toEqual(full);
    expect(forViewer(full, false)).toEqual({
      source: 'gati',
      lines: [
        { item: 'Gold 14K', kind: 'metal', weight: 2, unit: 'g' },
        { item: 'Diamonds', kind: 'diamond', weight: 0.5, unit: 'ct' },
      ],
    });
    expect(forViewer(null, true)).toBeNull();
  });
});

// ------------------------------------------------------------------- API
const PASSWORD = 'password123';
const REP = 'priya.rep@caratsense.in'; // salesperson
const HO = 'head.office@caratsense.in';
const PRODUCT = 'test-composition';

describe('design composition — who sees the amounts (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    for (const [k, email] of [['rep', REP], ['ho', HO]] as const) {
      tokens[k] = (await request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD })).body.token;
    }
    await prisma.product.upsert({
      where: { id: PRODUCT },
      update: {},
      create: {
        id: PRODUCT,
        sku: 'TEST-COMPOSITION',
        name: 'SK-TEST-COMP',
        metal: 'gold_18k',
        organisationId: 'org_eclat',
        storeId: null,
        legacyId: 'test-comp-1',
        composition: gatiComposition({ NetWt: 1.95, TotMtlAmt: 22748.7, TotDiaWt: 0.38, TotDiaPc: 52, TotDiaAmt: 15200, TotHandlingAmt: 3500 }, 'gold_18k') as object,
      },
    });
  });

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { id: PRODUCT } });
    await app?.close();
  });

  const get = (who: string) =>
    request(app.getHttpServer()).get(`/products/${PRODUCT}`).set('Authorization', `Bearer ${tokens[who]}`);

  it('head office sees every line with its amount', async () => {
    const res = await get('ho').expect(200);
    expect(res.body.composition.lines).toHaveLength(3);
    expect(res.body.composition.lines[0].amount).toBe(22748.7);
    expect(res.body.styleNumber).toBe('SK-TEST-COMP');
    expect(res.body.source).toBe('gati');
  });

  it('a salesperson sees weights and counts, never amounts or making', async () => {
    const res = await get('rep').expect(200);
    const lines = res.body.composition.lines;
    expect(lines.map((l: { item: string }) => l.item)).toEqual(['Gold 18K', 'Diamonds']);
    expect(lines.every((l: object) => !('amount' in l) && !('rate' in l))).toBe(true);
    expect(lines[1].pieces).toBe(52);
  });

  it('the style number finds it, in any case', async () => {
    const res = await request(app.getHttpServer())
      .get('/products?page=1&pageSize=5&q=sk-test-comp')
      .set('Authorization', `Bearer ${tokens.rep}`)
      .expect(200);
    expect(res.body.items.map((p: { id: string }) => p.id)).toEqual([PRODUCT]);
    expect(res.body.items[0].composition.lines[0].amount).toBeUndefined();
  });
});
