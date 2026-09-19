import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import type { PrismaService } from '../src/prisma/prisma.service';
import type { WebsiteCatalogueService } from '../src/catalogue/website/website-catalogue.service';
import { WebsiteCatalogueClient, WebsiteClientError } from '../src/catalogue/website/website-catalogue.client';

/**
 * The website connection tells the truth (docs/modules/05-catalogue-sources.md):
 * one canonical products endpoint, a real read-only probe before anything is
 * saved, "connected" only after that probe passed, and a schedule that ignores
 * a connection that has not. THE WEBSITE IS A STUB: nothing here reaches it.
 */

process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = '1';
process.env.SCHEDULER_ENABLED = 'false';
delete process.env.WEBSITE_CATALOGUE_ALLOWED_HOSTS;

const HOST = 'https://apis.eclatdiamonds.in';
const TOKEN = 'svc-probe-token-DO-NOT-LEAK-3c1d';

// ── the URL contract (pure) ─────────────────────────────────────────────────
describe('website products endpoint contract', () => {
  const client = new WebsiteCatalogueClient(new ConfigService({}));
  const ep = (u: string) => client.productsEndpoint(u).toString();

  it('turns the API base into the products endpoint', () => {
    expect(ep(`${HOST}/v1/api`)).toBe(`${HOST}/v1/api/products`);
    expect(ep(`${HOST}/v1/api/`)).toBe(`${HOST}/v1/api/products`);
  });

  it('never doubles an exact products endpoint', () => {
    expect(ep(`${HOST}/v1/api/products`)).toBe(`${HOST}/v1/api/products`);
    expect(ep(`${HOST}/v1/api/products/`)).toBe(`${HOST}/v1/api/products`);
    expect(ep(ep(`${HOST}/v1/api`))).toBe(`${HOST}/v1/api/products`);
  });

  it('keeps a reviewed query and drops page/limit', () => {
    expect(ep(`${HOST}/v1/api/products?country=IN&page=7&limit=5`)).toBe(`${HOST}/v1/api/products?country=IN`);
  });

  it('refuses http, credentials, fragments and hosts not on the allow-list', () => {
    for (const bad of ['http://apis.eclatdiamonds.in/v1/api', 'https://u:p@apis.eclatdiamonds.in/v1/api', `${HOST}/v1/api#x`, 'https://evil.example.com/v1/api']) {
      expect(() => client.productsEndpoint(bad)).toThrow(WebsiteClientError);
    }
  });

  it('pages with page/limit set once and the reviewed query intact', async () => {
    const urls: string[] = [];
    const c = new WebsiteCatalogueClient(new ConfigService({}));
    c.fetchImpl = (async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify({ data: [], total: 0 }), { status: 200 });
    }) as never;
    await c.fetchPage(`${HOST}/v1/api/products?country=IN&page=9`, null, 2, 100);
    const u = new URL(urls[0]);
    expect(u.pathname).toBe('/v1/api/products');
    expect(u.searchParams.getAll('page')).toEqual(['2']);
    expect(u.searchParams.getAll('limit')).toEqual(['100']);
    expect(u.searchParams.get('country')).toBe('IN');
  });

  it('refuses a redirect without following it, and sends no Authorization header without a token', async () => {
    const calls: { url: string; auth?: string }[] = [];
    const c = new WebsiteCatalogueClient(new ConfigService({}));
    c.retryBaseMs = 0;
    c.fetchImpl = (async (u: string, init: RequestInit) => {
      calls.push({ url: u, auth: (init.headers as Record<string, string>).Authorization });
      return new Response('', { status: 302, headers: { location: 'https://evil.example.com/' } });
    }) as never;
    await expect(c.probe(`${HOST}/v1/api`, null)).rejects.toThrow(/redirected/);
    expect(calls).toHaveLength(1); // refused outright: not retried, not followed
    expect(calls[0].auth).toBeUndefined();
  });
});

// ── the connection, end to end ──────────────────────────────────────────────
const C = { org: 'org_webconn_c', slug: 'webconn-c', store: 'store_webconn_c', ho: 'ho@webconn-c.local' };

async function teardown(prisma: PrismaService) {
  const where = { organisationId: C.org };
  await prisma.catalogueSyncRun.deleteMany({ where });
  await prisma.jobTask.deleteMany({ where });
  await prisma.integrationCredential.deleteMany({ where });
  await prisma.integration.deleteMany({ where });
  await prisma.auditLog.deleteMany({ where });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: C.org } } });
  await prisma.user.deleteMany({ where });
  await prisma.store.deleteMany({ where });
  await prisma.organisation.deleteMany({ where: { id: C.org } });
}

describe('Website connection health (e2e, stubbed website)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let website: WebsiteCatalogueService;
  let ho = '';
  const printed: string[] = [];
  // What the stub answers: a product list, a broken body, or an outage.
  const site = { mode: 'ok' as 'ok' | 'down' | 'no-list' | 'no-code', products: 3, requests: [] as string[], auth: [] as (string | undefined)[] };
  const fakeFetch = async (url: string, init: RequestInit) => {
    site.requests.push(url);
    site.auth.push((init.headers as Record<string, string>).Authorization);
    if (site.mode === 'down') return new Response('upstream down', { status: 503 });
    if (site.mode === 'no-list') return new Response(JSON.stringify({ message: 'ok' }), { status: 200 });
    const row = site.mode === 'no-code' ? { name: 'nameless' } : { productCode: 'P-1', name: 'One' };
    return new Response(JSON.stringify({ data: site.products ? [row] : [], pagination: { total: site.products } }), { status: 200 });
  };
  const server = () => app.getHttpServer();
  const as = () => ({ Authorization: `Bearer ${ho}` });
  const health = async () => (await request(server()).get('/catalogue-integration/health').set(as()).expect(200)).body;

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService: P } = await import('../src/prisma/prisma.service');
    const { WebsiteCatalogueService: W } = await import('../src/catalogue/website/website-catalogue.service');
    const { WebsiteCatalogueClient: WC } = await import('../src/catalogue/website/website-catalogue.client');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    const capture = (...a: unknown[]) => void printed.push(a.map(String).join(' '));
    app.useLogger({ log: capture, error: capture, warn: capture, debug: capture, verbose: capture, fatal: capture });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(P);
    website = app.get(W);
    const client = app.get(WC);
    client.fetchImpl = fakeFetch as never;
    client.retryBaseMs = 0;
    client.attempts = 1;
    await teardown(prisma);
    await prisma.organisation.create({ data: { id: C.org, name: C.slug, slug: C.slug, industryPackCode: 'jewellery' } });
    await prisma.store.create({ data: { id: C.store, name: 'C main', city: 'Mumbai', organisationId: C.org, timezone: 'Asia/Kolkata' } });
    await prisma.user.create({
      data: {
        id: 'u_webconn_ho', email: C.ho, name: 'HO', role: 'head_office', passwordHash: await bcrypt.hash('password123', 10),
        isActive: true, approvalStatus: 'approved', organisationId: C.org, userStores: { create: { storeId: C.store, isPrimary: true } },
      },
    });
    ho = (await request(server()).post('/auth/login').send({ email: C.ho, password: 'password123' }).expect(201)).body.token;
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    await app?.close();
  });

  it('a row saved before probes existed reads as configured but not verified', async () => {
    // What the old code wrote: an address and 'connected', with no probe behind it.
    await prisma.integration.create({
      data: { organisationId: C.org, providerCode: 'website_catalogue', name: 'Website catalogue', status: 'connected', config: { baseUrl: `${HOST}/v1/api` } },
    });
    expect((await health()).website).toMatchObject({
      configured: true,
      verified: false,
      connectionState: 'needs_attention',
      productsEndpoint: `${HOST}/v1/api/products`,
    });
    expect((await request(server()).post('/catalogue-integration/website/sync').set(as()).send({ mode: 'full', dryRun: true })).status).toBe(400);
    await prisma.integration.deleteMany({ where: { organisationId: C.org } });
  });

  it('a failed probe saves nothing and never reads as connected', async () => {
    site.mode = 'down';
    const res = await request(server()).post('/catalogue-integration/website/credential').set(as()).send({ baseUrl: `${HOST}/v1/api` });
    expect(res.status).toBe(502);
    expect(await prisma.integration.count({ where: { organisationId: C.org } })).toBe(0);
    expect((await health()).website).toMatchObject({ configured: false, verified: false, connectionState: 'not_configured' });
    // An answer that is not a product list is the address's fault, not the network's.
    site.mode = 'no-list';
    expect((await request(server()).post('/catalogue-integration/website/credential').set(as()).send({ baseUrl: `${HOST}/v1/api` })).status).toBe(400);
    site.mode = 'no-code';
    expect((await request(server()).post('/catalogue-integration/website/credential').set(as()).send({ baseUrl: `${HOST}/v1/api` })).status).toBe(400);
    expect(await prisma.integration.count({ where: { organisationId: C.org } })).toBe(0);
  });

  it('a passing probe saves the canonical endpoint, the source total and the check time', async () => {
    site.mode = 'ok';
    site.products = 3;
    const before = site.requests.length;
    const res = await request(server())
      .post('/catalogue-integration/website/credential')
      .set(as())
      .send({ baseUrl: `${HOST}/v1/api/products`, token: TOKEN })
      .expect(201);
    expect(res.body).toMatchObject({ configured: true, verified: true, productsEndpoint: `${HOST}/v1/api/products`, sourceTotal: 3 });
    const probe = new URL(site.requests[before]);
    expect(probe.pathname).toBe('/v1/api/products'); // not /products/products
    expect(probe.searchParams.get('limit')).toBe('1');
    const h = (await health()).website;
    expect(h).toMatchObject({ configured: true, verified: true, connectionState: 'connected', sourceTotal: 3, tokenStored: true, lastError: null });
    expect(h.lastHealthAt).toBeTruthy();
    expect(h.lastProbe).toMatchObject({ ok: true, sourceTotal: 3 });
    expect(h.lastRun).toBeNull();
  });

  it('a failing new address keeps the working one and records the attempt', async () => {
    site.mode = 'no-list';
    const res = await request(server()).post('/catalogue-integration/website/credential').set(as()).send({ baseUrl: `${HOST}/v2/api` });
    expect(res.status).toBe(400);
    const h = (await health()).website;
    expect(h).toMatchObject({ configured: true, verified: true, productsEndpoint: `${HOST}/v1/api/products` });
    expect(h.lastProbe).toMatchObject({ ok: false, endpoint: `${HOST}/v2/api/products` });
    // The stored token was used for the probe, and nothing ever echoed it.
    expect(site.auth[site.auth.length - 1]).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });

  it('Test connection separates configured from verified, and a failed one stops syncs', async () => {
    site.mode = 'down';
    expect((await request(server()).post('/catalogue-integration/website/test').set(as())).status).toBe(502);
    const h = (await health()).website;
    expect(h).toMatchObject({ configured: true, verified: false, connectionState: 'failed' });
    expect(h.lastError).toMatch(/503/);
    const sync = await request(server()).post('/catalogue-integration/website/sync').set(as()).send({ mode: 'full', dryRun: true });
    expect(sync.status).toBe(400);
    expect(sync.body.message).toMatch(/Test the connection first/);
    // A test starts no sync and writes no catalogue row.
    expect(await prisma.catalogueSyncRun.count({ where: { organisationId: C.org } })).toBe(0);
    expect(await prisma.product.count({ where: { organisationId: C.org } })).toBe(0);
  });

  it('the weekly schedule skips an unverified connection and picks it up once it passes', async () => {
    process.env.SCHEDULER_ENABLED = 'true';
    try {
      const mine = () => prisma.jobTask.count({ where: { organisationId: C.org, kind: 'catalogue.website_sync' } });
      await website.scheduleWeekly();
      expect(await mine()).toBe(0);
      site.mode = 'ok';
      await request(server()).post('/catalogue-integration/website/test').set(as()).expect(201);
      expect((await health()).website).toMatchObject({ verified: true, connectionState: 'connected' });
      await website.scheduleWeekly();
      expect(await mine()).toBe(1);
    } finally {
      process.env.SCHEDULER_ENABLED = 'false';
    }
  });

  it('never printed or stored the token in the clear', async () => {
    expect(printed.join('')).not.toContain(TOKEN);
    const audit = await prisma.auditLog.findMany({ where: { organisationId: C.org } });
    expect(JSON.stringify(audit)).not.toContain(TOKEN);
    expect(JSON.stringify(await health())).not.toContain(TOKEN);
  });
});
