import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

/**
 * The quote item master, rebuilt from Gati's own tables as the sync mirrors
 * them — so a design keyed into Gati can be quoted here without anyone loading
 * a file.
 *
 *  1. An empty mirror is "not synced yet": nothing is written.
 *  2. Items, sizes and each design's materials come out of the mirrored rows,
 *     the base metal first, sale rates only.
 *  3. Running it again with nothing changed writes nothing.
 *  4. A design added in Gati afterwards appears on the next run; nothing is
 *     removed because Gati no longer lists it.
 *  5. Only head office can run it by hand.
 */

const PASSWORD = 'password123';
const ORG = 'org_gim';
const STORE = 'store_gim';

async function teardown(prisma: import('../src/prisma/prisma.service').PrismaService) {
  await prisma.auditLog.deleteMany({ where: { organisationId: ORG } });
  await prisma.legacyRow.deleteMany({ where: { organisationId: ORG } });
  await prisma.styleBom.deleteMany({ where: { organisationId: ORG } });
  await prisma.materialSize.deleteMany({ where: { organisationId: ORG } });
  await prisma.material.deleteMany({ where: { organisationId: ORG } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: ORG } } });
  await prisma.user.deleteMany({ where: { organisationId: ORG } });
  await prisma.store.deleteMany({ where: { organisationId: ORG } });
  await prisma.organisation.deleteMany({ where: { id: ORG } });
}

describe('Item master from the mirrored Gati tables (e2e)', () => {
  let app: INestApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  const t: Record<string, string> = {};
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
  const refresh = (who = 'ho') => request(server()).post('/materials/refresh-from-gati').set(as(who));

  /** Mirror rows the way the agent sends them: numbers as numbers, bits as booleans. */
  const mirror = (table: string, rows: Record<string, unknown>[], key: string) =>
    prisma.legacyRow.createMany({
      data: rows.map((data) => ({ organisationId: ORG, sourceTable: table, rowKey: String(data[key]), data: data as object })),
    });

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService } = await import('../src/prisma/prisma.service');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    await teardown(prisma);

    await prisma.organisation.create({ data: { id: ORG, name: 'Gim', slug: 'gim', industryPackCode: 'jewellery' } });
    await prisma.store.create({ data: { id: STORE, name: 'Counter', city: 'Mumbai', organisationId: ORG } });
    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const [who, role] of [['ho', 'head_office'], ['rep', 'salesperson']] as const) {
      await prisma.user.create({
        data: {
          id: `u_gim_${who}`, email: `${who}@gim.local`, name: `gim ${who}`, role, passwordHash: hash,
          isActive: true, approvalStatus: 'approved', organisationId: ORG,
          userStores: { create: { storeId: STORE, isPrimary: true } },
        },
      });
      t[who] = (await request(server()).post('/auth/login').send({ email: `${who}@gim.local`, password: PASSWORD }).expect(201)).body.token;
    }
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  it('an empty mirror writes nothing', async () => {
    const res = await refresh().expect(201);
    expect(res.body).toEqual({ synced: false });
    expect(await prisma.material.count({ where: { organisationId: ORG } })).toBe(0);
  });

  it('builds items, sizes and each design\'s materials from the mirrored rows', async () => {
    await mirror('RawMst', [
      { RawNo: 8, RawCode: 'G', RawName: 'GOLD', RawMitNo: 1 },
      { RawNo: 20, RawCode: 'LG', RawName: 'Labgrown Polish Diamond', RawMitNo: 0 },
    ], 'RawNo');
    await mirror('QualityMst', [{ QlyNo: 3, QlyCode: '14KT' }, { QlyNo: 9, QlyCode: 'VVS' }], 'QlyNo');
    await mirror('ToneMst', [{ ToneNo: 1, ToneCode: 'YG' }, { ToneNo: 5, ToneCode: 'E-F' }], 'ToneNo');
    await mirror('ShapeMst', [{ ShapeNo: 2, ShapeCode: 'RND' }], 'ShapeNo');
    // Gati spells this column GsizeNo here and GSizeNo on the rate table.
    await mirror('SizeMst', [{ SizeNo: 40, SizeName: '3.5-4', SizeMM: '3.5-4', Pointer: 0.013, GsizeNo: 3, SortOrderNo: 7 }], 'SizeNo');
    await mirror('SPM_CommonMaster', [{ CommonMasterId: 12, CommonMasterName: '12' }], 'CommonMasterId');
    await mirror('MainProduct', [{ GrpNo: 1, GrpPrefix: 'ALR', GrpName: 'LADIES RING' }], 'GrpNo');
    await mirror('RateChartRangeMstDetail', [{ RateChartRangeMstDetailId: 77, MinWeight: 0.01, MaxWeight: 0.09 }], 'RateChartRangeMstDetailId');
    await mirror('RateMst', [
      { RateId: 1, ItemId: 2, RateChartId: 2, RateChartRangeMstDetailId: 77, SaleRate: 20000, CostRate: 3066 },
      { RateId: 2, ItemId: 2, RateChartId: 1, GSizeNo: 3, SaleRate: 20000, CostRate: 3066 },
      { RateId: 3, ItemId: 2, RateChartId: 1, GSizeNo: 4, SaleRate: 0 },
    ], 'RateId');
    await mirror('SPM_Items', [
      { ItemId: 1, ItemCode: 'G14YG', ItemName: 'GOLD14YG', RawNo: 8, QlyNo: 3, ToneNo: 1 },
      { ItemId: 2, ItemCode: 'LG-RND-VVS-E-F', ItemName: 'Labgrown RND VVS E-F', RawNo: 20, QlyNo: 9, ToneNo: 5, ShapeNo: 2 },
    ], 'ItemId');
    await mirror('StyleMst', [{ StyleId: 10, StyleCode: '10778RG', GrpNo: 1, ItemSizeId: 12 }], 'StyleId');
    await mirror('StyleMstDetail', [
      // Keyed stone-first in Gati; the base metal must still come out first.
      { StyleMstDetailID: 1, StyleId: 10, ItemId: 2, NetWeight: 0.312, SizeNo: 40, Pieces: 24, IsBase: false },
      { StyleMstDetailID: 2, StyleId: 10, ItemId: 1, NetWeight: 3.6, IsBase: true },
    ], 'StyleMstDetailID');

    const res = await refresh().expect(201);
    expect(res.body).toEqual({ synced: true, materials: 3, sizes: 1, styles: 1, changed: true });

    const master = (await request(server()).get('/materials').set(as('rep')).expect(200)).body;
    expect(master.itemTypes).toEqual([{ code: 'ALR', name: 'LADIES RING' }]);
    expect(master.metals[0]).toMatchObject({ code: 'G14YG', karat: 14, tone: 'YG' });
    expect(master.diamonds[0]).toMatchObject({
      code: 'LG-RND-VVS-E-F', shape: 'RND', quality: 'VVS',
      // The sale rate by weight band and by size group; a zero rate is not a rate.
      saleRates: { bands: [[0.01, 0.09, 20000]], groups: { '3': 20000 } },
    });
    expect(JSON.stringify(master)).not.toContain('3066'); // never the cost
    expect(master.sizes[0]).toMatchObject({ code: '3.5-4', caratPerPiece: 0.013, sizeGroup: '3' });

    const style = (await request(server()).get('/materials/styles/10778').set(as('rep')).expect(200)).body;
    expect(style).toMatchObject({
      styleCode: '10778RG', itemType: 'ALR', itemSize: '12',
      lines: [
        { code: 'G14YG', weight: 3.6 },
        { code: 'LG-RND-VVS-E-F', weight: 0.312, size: '3.5-4', pieces: 24 },
      ],
    });
  });

  it('writes nothing when nothing changed, and picks up a design added later', async () => {
    expect((await refresh().expect(201)).body).toMatchObject({ synced: true, changed: false });

    await mirror('StyleMst', [{ StyleId: 11, StyleCode: '11018ER', GrpNo: 1 }], 'StyleId');
    await mirror('StyleMstDetail', [{ StyleMstDetailID: 3, StyleId: 11, ItemId: 1, NetWeight: 3.38, IsBase: true }], 'StyleMstDetailID');
    expect((await refresh().expect(201)).body).toMatchObject({ styles: 2, changed: true });
    const added = (await request(server()).get('/materials/styles/11018ER').set(as('rep')).expect(200)).body;
    expect(added.lines).toEqual([{ code: 'G14YG', weight: 3.38 }]);

    // A design Gati no longer lists stays quotable: this only ever adds and updates.
    await prisma.legacyRow.deleteMany({ where: { organisationId: ORG, sourceTable: 'StyleMst', rowKey: '10' } });
    await refresh().expect(201);
    await request(server()).get('/materials/styles/10778RG').set(as('rep')).expect(200);

    const audit = await prisma.auditLog.count({ where: { organisationId: ORG, systemActorId: 'gati_item_master' } });
    expect(audit).toBe(3); // one per run that wrote, none for the run that did not
  });

  it('only head office can run it by hand', async () => {
    await refresh('rep').expect(403);
  });
});
