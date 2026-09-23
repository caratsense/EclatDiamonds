import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PrismaService } from '../src/prisma/prisma.service';
import { rupeesInWords } from '../src/quotes/quote-pdf';

const pdfParse: (data: Buffer) => Promise<{ text: string }> = require('pdf-parse/lib/pdf-parse.js');

/**
 * The item master and item-level quote pricing.
 *
 *  1. Head office loads the master (item types, metals, diamonds, colour
 *     stones, sizes, style BOMs); everyone who quotes reads it; nobody else
 *     loads it.
 *  2. An item prices making as rate x weight and each stone as carats x rate x
 *     multiplier — the server's amounts, not the client's.
 *  3. Discount: a % off making, a % off stones, a flat amount at the end;
 *     never into the gold. `discountPercent` is what they come to overall.
 *  4. Only real karats, no negative carats, sizes are plain text.
 *  5. The PDF itemises by code with the multiplier already in the rate, the
 *     size, the discounts and the total in words.
 *  6. Booking the quote as a custom order carries the item type, size and
 *     materials across.
 */

const PASSWORD = 'password123';
const A = { org: 'org_qm', slug: 'qm', store: 'store_qm' };

const MASTER = {
  materials: [
    { code: 'ALR', name: 'LADIES RING', kind: 'item_type' },
    { code: 'G14YG', name: 'GOLD14YG', kind: 'metal', groupCode: 'G', karat: 14, tone: 'YG' },
    {
      code: 'LG-RND-VVS-E-F', name: 'Labgrown DiamondRNDVVSE-F', kind: 'diamond', groupCode: 'LG', shape: 'RND',
      saleRates: { bands: [[0, 0.09, 20000], [0.09, 0.24, 23000]] },
    },
    { code: 'LG-RB-OVL', name: 'Labgrown RubyOVL', kind: 'stone', groupCode: 'LGRB', shape: 'OVL' },
  ],
  sizes: [{ code: '1.5-2', mm: '1.20 mm', caratPerPiece: 0.008, sizeGroup: '24', sortOrder: 6 }],
  styles: [
    {
      styleCode: 'ALR-0006', itemType: 'ALR', itemSize: 'IND 13',
      lines: [{ code: 'G14YG', weight: 3.93 }, { code: 'LG-RND-VVS-E-F', size: '1.5-2', pieces: 12, weight: 0.096 }],
    },
  ],
};

/** metal 3.2 g x 6000 = 19,200; making 1,500/g = 4,800; stones 4,800 + 2,500 = 7,300. */
const ITEM = {
  description: 'LADIES RING', karat: 14, weightGrams: 3.2, goldRatePerGram: 6000,
  styleNumber: 'ALR-0006', size: '12', metalCode: 'G14YG', makingRatePerGram: 1500,
  stones: [
    { type: 'D', code: 'LG-RND-VVS-E-F', size: '1.5-2', pieces: 12, carats: 0.16, ratePerCt: 20000, multiplier: 1.5 },
    { type: 'C', code: 'LG-RB-OVL', carats: 0.5, ratePerCt: 5000 },
  ],
};

async function teardown(prisma: PrismaService) {
  await prisma.customOrderEvent.deleteMany({ where: { order: { organisationId: A.org } } });
  await prisma.customOrder.deleteMany({ where: { organisationId: A.org } });
  await prisma.activityEvent.deleteMany({ where: { organisationId: A.org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: A.org } });
  await prisma.productInteraction.deleteMany({ where: { organisationId: A.org } });
  await prisma.quoteLine.deleteMany({ where: { quote: { organisationId: A.org } } });
  await prisma.quoteRedeemableStore.deleteMany({ where: { quote: { organisationId: A.org } } });
  await prisma.quote.deleteMany({ where: { organisationId: A.org } });
  await prisma.contactPoint.deleteMany({ where: { organisationId: A.org } });
  await prisma.mergeCandidate.deleteMany({ where: { organisationId: A.org } });
  await prisma.party.deleteMany({ where: { organisationId: A.org } });
  await prisma.material.deleteMany({ where: { organisationId: A.org } });
  await prisma.materialSize.deleteMany({ where: { organisationId: A.org } });
  await prisma.styleBom.deleteMany({ where: { organisationId: A.org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: A.org } } });
  await prisma.user.deleteMany({ where: { organisationId: A.org } });
  await prisma.store.deleteMany({ where: { organisationId: A.org } });
  await prisma.organisation.deleteMany({ where: { id: A.org } });
}

describe('Item master + item-level quote pricing (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let privateDir: string;
  const t: Record<string, string> = {};
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
  const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  };
  const quote = (body: Record<string, unknown>) =>
    request(server())
      .post('/quotes')
      .set(as('rep'))
      .send({ storeId: A.store, customerName: 'Item Customer', phone: '9812370199', ...body });

  beforeAll(async () => {
    privateDir = mkdtempSync(join(tmpdir(), 'eclat-qm-'));
    process.env.PRIVATE_UPLOAD_DIR = privateDir;
    const { AppModule } = await import('../src/app.module');
    const { PrismaService: P } = await import('../src/prisma/prisma.service');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(P);
    await teardown(prisma);

    await prisma.organisation.create({ data: { id: A.org, name: 'Qm', slug: A.slug, industryPackCode: 'jewellery' } });
    await prisma.store.create({ data: { id: A.store, name: 'Andheri', city: 'Mumbai', organisationId: A.org } });
    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const [who, role] of [['ho', 'head_office'], ['rep', 'salesperson']] as const) {
      await prisma.user.create({
        data: {
          id: `u_qm_${who}`, email: `${who}@qm.local`, name: `qm ${who}`, role, passwordHash: hash,
          isActive: true, approvalStatus: 'approved', organisationId: A.org,
          userStores: { create: { storeId: A.store, isPrimary: true } },
        },
      });
      t[who] = (await request(server()).post('/auth/login').send({ email: `${who}@qm.local`, password: PASSWORD }).expect(201)).body.token;
    }
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
    rmSync(privateDir, { recursive: true, force: true });
  });

  it('head office loads the master; everyone who quotes reads it; nobody else loads it', async () => {
    await request(server()).put('/materials').set(as('rep')).send(MASTER).expect(403);
    const loaded = await request(server()).put('/materials').set(as('ho')).send(MASTER).expect(200);
    expect(loaded.body).toEqual({ materials: 4, sizes: 1, styles: 1 });
    // Idempotent: a second load updates in place.
    await request(server()).put('/materials').set(as('ho')).send(MASTER).expect(200);
    expect(await prisma.material.count({ where: { organisationId: A.org } })).toBe(4);

    const m = (await request(server()).get('/materials').set(as('rep')).expect(200)).body;
    expect(m.itemTypes).toEqual([{ code: 'ALR', name: 'LADIES RING' }]);
    expect(m.metals.map((x: { code: string }) => x.code)).toEqual(['G14YG']);
    expect(m.diamonds[0].saleRates.bands[0]).toEqual([0, 0.09, 20000]);
    expect(m.stones[0].code).toBe('LG-RB-OVL');
    expect(m.sizes[0]).toMatchObject({ code: '1.5-2', mm: '1.20 mm', caratPerPiece: 0.008 });

    const style = (await request(server()).get('/materials/styles/alr-0006').set(as('rep')).expect(200)).body;
    expect(style).toMatchObject({ styleCode: 'ALR-0006', itemType: 'ALR', itemSize: 'IND 13' });
    expect(style.lines).toHaveLength(2);
    await request(server()).get('/materials/styles/NOPE-1').set(as('rep')).expect(404);
    const found = (await request(server()).get('/materials/styles?q=ALR').set(as('rep')).expect(200)).body;
    expect(found).toEqual([{ styleCode: 'ALR-0006', itemType: 'ALR', itemSize: 'IND 13' }]);
  });

  let quoteId = '';

  it('prices an item from its materials, with making, stone and additional discounts', async () => {
    const res = await quote({
      lines: [ITEM], makingDiscountPercent: 10, stoneDiscountPercent: 5, additionalDiscount: 500,
    }).expect(201);
    quoteId = res.body.id;
    const line = res.body.lines[0];
    expect(line).toMatchObject({ makingCharges: 4800, stoneCharges: 7300, caratWeight: 0.66, size: '12', metalCode: 'G14YG' });
    expect(line.stones.map((s: { amount: number }) => s.amount)).toEqual([4800, 2500]);
    expect(line.stones[1].multiplier).toBe(1);
    expect(res.body).toMatchObject({ makingDiscountPercent: 10, stoneDiscountPercent: 5, additionalDiscount: 500, discountPercent: 11.12 });
    // 480 off making + 365 off stones + 500 = 1,345; taxable 29,955; GST 898.65.
    expect(res.body.totals).toMatchObject({
      metalValue: 19200, makingCharges: 4800, stoneCharges: 7300, discount: 1345,
      makingDiscount: 480, stoneDiscount: 365, additionalDiscount: 500, taxable: 29955, gst: 898.65,
      // Settled in whole rupees, like the shop's own bill: 30,853.65 + 0.35.
      roundOff: 0.35, grandTotal: 30854,
    });

    // An edit that sends only the additional discount keeps the percentages.
    const edited = await request(server()).patch(`/quotes/${quoteId}`).set(as('rep')).send({ additionalDiscount: 0 }).expect(200);
    expect(edited.body.totals).toMatchObject({ discount: 845, makingDiscount: 480, stoneDiscount: 365, additionalDiscount: 0 });
    expect(edited.body.lines[0].stones).toHaveLength(2);
    await request(server()).patch(`/quotes/${quoteId}`).set(as('rep')).send({ additionalDiscount: 500 }).expect(200);
  });

  it('an old-style caller with one discount % gets it on making and stones both', async () => {
    const res = await quote({
      discountPercent: 10,
      lines: [{ description: 'Solitaire ring', karat: 18, weightGrams: 10, goldRatePerGram: 6000, makingCharges: 10000, stoneCharges: 20000 }],
    }).expect(201);
    expect(res.body).toMatchObject({ discountPercent: 10, makingDiscountPercent: 10, stoneDiscountPercent: 10 });
    expect(res.body.totals).toMatchObject({ discount: 3000, makingDiscount: 1000, stoneDiscount: 2000 });
  });

  it('refuses unreal karats, negative carats, odd sizes and a discount that reaches the gold', async () => {
    await quote({ lines: [{ ...ITEM, karat: 10 }] }).expect(400);
    await quote({ lines: [{ ...ITEM, stones: [{ ...ITEM.stones[0], carats: -0.5 }] }] }).expect(400);
    await quote({ lines: [{ ...ITEM, stones: [{ ...ITEM.stones[0], type: 'X' }] }] }).expect(400);
    await quote({ lines: [{ ...ITEM, size: '12<b>' }] }).expect(400);
    const tooMuch = await quote({ lines: [ITEM], additionalDiscount: 12101 }).expect(400);
    expect(JSON.stringify(tooMuch.body)).toMatch(/Gold is never discounted/);
    await quote({ lines: [{ ...ITEM, karat: 12, size: '16 inch' }], additionalDiscount: 12100 }).expect(201);
  });

  it('the PDF is the shop bill: codes, size, per-line discount, the tax split and the words', async () => {
    const file = await request(server()).get(`/quotes/${quoteId}/pdf`).set(as('rep')).buffer(true).parse(binary).expect(200);
    const text = (await pdfParse(file.body as Buffer)).text;
    for (const s of [
      'Quotation',
      'Details of the Receiver (Billed To)',
      'Details of Consignee (Shipped To)',
      'LADIES RING', 'StyleCode : ALR-0006', 'Size : 12', 'G14YG', 'LG-RND-VVS-E-F', 'LG-RB-OVL',
      // The bill's own four labels, in its order. HUID and the lab certificate
      // belong to a piece that has been made, so on a quotation they print as
      // empty fields rather than being dropped off the form.
      'HUID :', 'HSN No :', 'J_Certi :',
      '30,000.00', // the rate the customer sees: 20,000 x the 1.5 multiplier
      '-10%', '-5%', // making and diamond discount, per line, as the bill shows it
      'Less : Discount', '1.5% SGST', '1.5% CGST', 'Rounding', 'Total',
      'INR THIRTY THOUSAND EIGHT HUNDRED FIFTY FOUR ONLY',
      // The bank block and the payment block, as the shop's bill lays them out.
      'A/C Name', 'Bank Name', 'Bank Address', 'Bank A/C No', 'Bank IFSC', 'Remarks',
      'Payment', 'Received', 'Balance Payment :',
      'Invoice Issued Under Section 31 (1) of the GST Act',
      'This is a quotation and not a tax invoice',
      'Customer Signature', 'Authorized Signature',
    ]) {
      expect(text).toContain(s);
    }
    // The staff's base rate and the multiplier are not what the customer is shown.
    expect(text).not.toContain('20,000.00');
    expect(text).not.toMatch(/multiplier/i);
  });

  it('writes amounts in words the Indian way', () => {
    // "INR", not "Rupees": the prefix the shop's own bill carries on this line.
    expect(rupeesInWords(0)).toBe('INR Zero Only');
    expect(rupeesInWords(100000)).toBe('INR One Lakh Only');
    expect(rupeesInWords(12345678.9)).toBe(
      'INR One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Ninety Paise Only',
    );
  });

  it('a custom order booked from the quote carries the item type, size and materials', async () => {
    const res = await request(server()).post(`/quotes/${quoteId}/convert-to-order`).set(as('rep')).send({}).expect(201);
    const order = await prisma.customOrder.findUniqueOrThrow({ where: { id: res.body.order.id } });
    expect(order).toMatchObject({ item: 'LADIES RING', category: 'ring', ringSize: '12', bangleSize: null });
    expect(order.details).toContain('D LG-RND-VVS-E-F 1.5-2 12 pc 0.16 ct');
    expect(order.details).not.toMatch(/20000|30000/);
  });
});
