import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Metal rates from Gati's Daily Rate master (RateDailyMst) through the real
 * machine-auth ingestion route, with GOLD_RATE_SOURCE=gati.
 *
 * Proves: fine GOLD becomes every gold purity and SILVER stays per gram; the
 * rates screen names Gati as the source; an unchanged re-send renews rather
 * than piling up rows; a changed rate becomes the live one; OLD GOLD is not a
 * selling price and is reported as skipped; a feed pull changes nothing.
 */
const PASSWORD = 'password123';
const HO = 'head.office@caratsense.in';
const ORG = 'org_eclat';
const PROFILE_HASH = 'a'.repeat(64);
const SOURCE_INSTANCE_HASH = 'b'.repeat(64);
const RUN = `${Date.now()}`;

describe('Gati daily rates -> MetalRate (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ho: Record<string, string>;
  let agentToken: string;
  let agentId: string;
  let configRevision: string;
  const previousSource = process.env.GOLD_RATE_SOURCE;

  const agentHeaders = () => ({
    Authorization: `Bearer ${agentToken}`,
    'x-caratos-profile-id': 'gati-rates-e2e',
    'x-caratos-profile-hash': PROFILE_HASH,
    'x-caratos-source-instance-hash': SOURCE_INSTANCE_HASH,
    'x-caratos-config-revision': configRevision,
  });
  const postRates = (records: Record<string, unknown>[]) =>
    request(app.getHttpServer()).post('/sync/rates').set(agentHeaders()).send({ records });
  const rates = async () => {
    const r = await request(app.getHttpServer()).get('/integrations/gold-rate').set(ho);
    expect(r.status).toBe(200);
    return new Map<string, any>(r.body.map((x: any) => [x.metal, x]));
  };
  const day = (rate: number, date: string) => [
    { RawNo: 8, RawName: 'GOLD', SaleRate: rate, RateDate: `${date}T00:00:00.000Z`, UpdateDate: `${date}T09:00:00.000Z` },
    { RawNo: 11, RawName: 'SILVER', SaleRate: 222, RateDate: `${date}T00:00:00.000Z`, UpdateDate: `${date}T09:00:00.000Z` },
  ];

  beforeAll(async () => {
    process.env.GOLD_RATE_SOURCE = 'gati';
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
    ho = { Authorization: `Bearer ${login.body.token}` };
    const enrolled = await request(app.getHttpServer())
      .post('/integration/connect/agents')
      .set(ho)
      .send({ name: `GATIRATES ${RUN}`, sourceSystem: 'gati' });
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
  });

  afterAll(async () => {
    await prisma.metalRate.deleteMany({ where: { organisationId: ORG, legacyId: { startsWith: 'gati:2099-' } } });
    await prisma.connectAgent.deleteMany({ where: { id: agentId } });
    if (previousSource === undefined) delete process.env.GOLD_RATE_SOURCE;
    else process.env.GOLD_RATE_SOURCE = previousSource;
    await app.close();
  });

  it('maps fine GOLD to every purity and SILVER per gram, sourced from Gati', async () => {
    const res = await postRates(day(14800, '2099-01-01'));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ entity: 'rates', received: 2, upserted: 2, skipped: 0 });

    const r = await rates();
    expect(r.get('gold_24k')).toMatchObject({ ratePerGram: 14800, source: 'gati', stale: false, publishedOn: '2099-01-01' });
    expect(r.get('gold_22k')?.ratePerGram).toBe(13556.8);
    expect(r.get('gold_18k')?.ratePerGram).toBe(11100);
    expect(r.get('gold_14k')?.ratePerGram).toBe(8658);
    expect(r.get('gold_9k')?.derived).toBe(true);
    expect(r.get('silver')).toMatchObject({ ratePerGram: 222, source: 'gati' });
  });

  it('renews an unchanged rate instead of adding rows', async () => {
    const before = await prisma.metalRate.count({ where: { organisationId: ORG, legacyId: { startsWith: 'gati:2099-' } } });
    expect((await postRates(day(14800, '2099-01-01'))).status).toBe(201);
    const after = await prisma.metalRate.count({ where: { organisationId: ORG, legacyId: { startsWith: 'gati:2099-' } } });
    expect(after).toBe(before);
  });

  it('makes a changed rate the live one', async () => {
    expect((await postRates(day(14970, '2099-01-02'))).status).toBe(201);
    const r = await rates();
    expect(r.get('gold_24k')).toMatchObject({ ratePerGram: 14970, publishedOn: '2099-01-02' });
  });

  it('reports OLD GOLD (a buy-back rate) as skipped, not stored', async () => {
    const res = await postRates([{ RawNo: 18, RawName: 'OLD GOLD', SaleRate: 14800, RateDate: '2099-01-02T00:00:00.000Z' }]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ received: 1, upserted: 0, skipped: 1 });
  });

  it('does not pull a feed over the Gati rate, and reports Gati health', async () => {
    const pulled = await request(app.getHttpServer()).post('/integrations/gold-rate/refresh').set(ho);
    expect(pulled.status).toBe(201);
    expect(pulled.body.updated).toBe(false);
    expect((await rates()).get('gold_24k')).toMatchObject({ ratePerGram: 14970, source: 'gati' });

    const health = await request(app.getHttpServer()).get('/integrations/gold-rate/health').set(ho);
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ source: 'gati', overdue: false });
  });
});
