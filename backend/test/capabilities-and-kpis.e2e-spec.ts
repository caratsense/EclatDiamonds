import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Per-tenant module switches, and the management view.
 *
 * ## What Block 14 is defending
 *
 * THE URL IS NOT THE POLICY. Hiding a module in the sidebar is worthless if
 * typing its address still works, so the navigation list and the entitlement
 * guard read the SAME capability. Every "hidden" assertion below is made against
 * the API, not against a rendered menu.
 *
 * A TENANT SWITCH IS NOT A PACK EDIT. Éclat runs the jewellery pack and does not
 * want Marketing or Stock Transfer. Removing them from the pack would take them
 * from every jewellery tenant, and hard-coding a slug would put a customer's
 * name in the authorisation path. The pack keeps describing the industry; the
 * tenant records what it turned off, and the second jewellery tenant here proves
 * the two do not interfere.
 *
 * THE SPINE CANNOT BE REMOVED. Switching off the team screen removes the only
 * screen that could switch it back on.
 *
 * ## What Block 15 is defending
 *
 * EVERY FIGURE IS A DATABASE AGGREGATE. The clearest way to prove it is to
 * exceed an ordinary page limit: 1,200 leads, and the total has to say 1,200.
 *
 * ZERO IS NOT "CANNOT SAY". A ratio with no denominator is null and carries its
 * working, because a branch that converted none of forty leads and one that had
 * no leads at all are different Tuesdays.
 *
 * DAYS ARE COUNTED WHERE THE SHOP IS. Two branches 25 hours apart, and the
 * response says which clock it used and that they disagreed.
 *
 * ARCHIVED IS NOT ACTIVE, AND A DRY RUN IS NOT A DELIVERY. Both are counted
 * deliberately, and both are the kind of number that quietly inflates for
 * months before anybody notices.
 *
 * FIXTURE-TESTED. No provider is contacted anywhere in this file.
 */

process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 41).toString('base64');
process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = '1';

const PASSWORD = 'password123';

/** Éclat: jewellery, two branches, 25 hours apart to make the clock question real. */
const A = {
  org: 'org_cap_a',
  slug: 'cap-a',
  east: 'store_cap_east',
  west: 'store_cap_west',
  ho: 'ho.cap@cap-a.local',
  mgr: 'mgr.cap@cap-a.local',
  rep: 'rep.cap@cap-a.local',
  rep2: 'rep2.cap@cap-a.local',
};

/** A second jewellery tenant, to prove one tenant's switch is not the pack's. */
const B = {
  org: 'org_cap_b',
  slug: 'cap-b',
  store: 'store_cap_b',
  ho: 'ho.cap@cap-b.local',
};

/** UTC+14 and UTC-11. Every instant of the year falls on two different dates. */
const EAST_TZ = 'Pacific/Kiritimati';
const WEST_TZ = 'Pacific/Niue';

/** Above any ordinary page limit, so a capped count would be visibly wrong. */
const BULK_LEADS = 1200;

async function teardown(prisma: PrismaService) {
  for (const org of [A.org, B.org]) {
    await prisma.leadTagAssignment.deleteMany({ where: { organisationId: org } });
    await prisma.leadTag.deleteMany({ where: { organisationId: org } });
    await prisma.attributionTouch.deleteMany({ where: { organisationId: org } });
    await prisma.task.deleteMany({ where: { organisationId: org } });
    await prisma.lead.deleteMany({ where: { organisationId: org } });
    await prisma.checkIn.deleteMany({ where: { organisationId: org } });
    await prisma.feedbackRequest.deleteMany({ where: { organisationId: org } });
    await prisma.auditLog.deleteMany({ where: { organisationId: org } });
    await prisma.party.deleteMany({ where: { organisationId: org } });
    await prisma.userStore.deleteMany({ where: { user: { organisationId: org } } });
    await prisma.user.deleteMany({ where: { organisationId: org } });
    await prisma.store.deleteMany({ where: { organisationId: org } });
    await prisma.organisation.deleteMany({ where: { id: org } });
  }
}

describe('Tenant module switches and the management view (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let hoT = '';
  let mgrT = '';
  let repT = '';
  let rep2T = '';
  let hoBT = '';

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const login = async (email: string) =>
    (
      await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201)
    ).body.token;

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
      data: {
        id: A.org,
        name: 'Cap A',
        slug: A.slug,
        industryPackCode: 'jewellery',
        timezone: EAST_TZ,
      },
    });
    await prisma.store.createMany({
      data: [
        { id: A.east, name: 'East', city: 'East', organisationId: A.org, timezone: EAST_TZ },
        { id: A.west, name: 'West', city: 'West', organisationId: A.org, timezone: WEST_TZ },
      ],
    });
    await prisma.organisation.create({
      data: { id: B.org, name: 'Cap B', slug: B.slug, industryPackCode: 'jewellery' },
    });
    await prisma.store.create({
      data: { id: B.store, name: 'B main', city: 'B', organisationId: B.org },
    });

    for (const [id, email, org, store, role] of [
      ['u_cap_ho', A.ho, A.org, A.east, 'head_office'],
      ['u_cap_mgr', A.mgr, A.org, A.east, 'store_manager'],
      ['u_cap_rep', A.rep, A.org, A.east, 'salesperson'],
      ['u_cap_rep2', A.rep2, A.org, A.west, 'salesperson'],
      ['u_cap_ho_b', B.ho, B.org, B.store, 'head_office'],
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
          organisationId: org,
          userStores: { create: { storeId: store, isPrimary: true } },
        },
      });
    }

    hoT = await login(A.ho);
    mgrT = await login(A.mgr);
    repT = await login(A.rep);
    rep2T = await login(A.rep2);
    hoBT = await login(B.ho);
  }, 240_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  /* ============================================ 1. the switches themselves */

  describe('switching a module off', () => {
    it('starts with everything the industry includes', async () => {
      const res = await request(server())
        .get('/config/capabilities')
        .set(auth(hoT))
        .expect(200);
      const on = res.body.modules.filter((m: { enabled: boolean }) => m.enabled);
      expect(on.map((m: { capability: string }) => m.capability)).toContain('marketing');
      expect(on.map((m: { capability: string }) => m.capability)).toContain('stock-transfers');
      expect(res.body.disabled).toEqual([]);
    });

    it('lets the API be reached before it is switched off', async () => {
      await request(server()).get('/marketing/campaigns').set(auth(hoT)).expect(200);
      await request(server()).get('/stock-transfers').set(auth(hoT)).expect(200);
    });

    it('switches Marketing and Stock Transfer off for this tenant', async () => {
      const res = await request(server())
        .put('/config/capabilities')
        .set(auth(hoT))
        .send({ disabled: ['marketing', 'stock-transfers'] })
        .expect(200);
      expect(res.body.disabled.sort()).toEqual(['marketing', 'stock-transfers']);
      const marketing = res.body.modules.find(
        (m: { capability: string }) => m.capability === 'marketing',
      );
      expect(marketing.enabled).toBe(false);
    });

    it('REFUSES THE API, not merely the menu', async () => {
      // The whole point. A screen that is only missing from a sidebar is one
      // bookmark away from being used.
      const res = await request(server())
        .get('/marketing/campaigns')
        .set(auth(hoT))
        .expect(403);
      expect(String(res.body.message)).toContain('switched off for your organisation');
      // And it names the screen that can undo it, rather than telling somebody
      // to change their industry — which would be the wrong advice entirely.
      expect(String(res.body.message)).toContain('Modules');

      await request(server()).get('/stock-transfers').set(auth(hoT)).expect(403);
    });

    it('refuses it for every role, not just the one who switched it off', async () => {
      for (const token of [mgrT, repT]) {
        await request(server()).get('/marketing/campaigns').set(auth(token)).expect(403);
      }
    });

    it('takes it out of the navigation the client is given', async () => {
      const res = await request(server()).get('/config/bootstrap').set(auth(hoT)).expect(200);
      const nav: string[] = res.body.industry.enabledNavigation;
      expect(nav).not.toContain('marketing');
      expect(nav).not.toContain('stock-transfers');
      // The rest of the jewellery product is untouched.
      expect(nav).toContain('quotation');
      expect(nav).toContain('inventory');
      // And what the INDUSTRY includes is still reported, so the modules screen
      // can offer them back.
      expect(res.body.industry.packNavigation).toContain('marketing');
    });

    it('says the same thing at login as it does at /config/bootstrap', async () => {
      const res = await request(server())
        .post('/auth/login')
        .send({ email: A.ho, password: PASSWORD })
        .expect(201);
      // A user handed one navigation list at login and refused by the server on
      // the next request would look like a broken product.
      expect(res.body.productProfile.enabledNavigation).not.toContain('marketing');
    });

    it('leaves the OTHER jewellery tenant completely alone', async () => {
      // The reason this is a tenant switch and not a pack edit.
      await request(server()).get('/marketing/campaigns').set(auth(hoBT)).expect(200);
      const res = await request(server()).get('/config/bootstrap').set(auth(hoBT)).expect(200);
      expect(res.body.industry.enabledNavigation).toContain('marketing');
    });

    it('switches one back on again', async () => {
      await request(server())
        .put('/config/capabilities')
        .set(auth(hoT))
        .send({ disabled: ['marketing'] })
        .expect(200);
      await request(server()).get('/stock-transfers').set(auth(hoT)).expect(200);
      await request(server()).get('/marketing/campaigns').set(auth(hoT)).expect(403);
    });

    it('records both sides of the change, because nobody remembers making it', async () => {
      const log = await prisma.auditLog.findFirst({
        where: { organisationId: A.org, action: 'config.capabilities_changed' },
        orderBy: { createdAt: 'desc' },
      });
      expect(log).toBeTruthy();
      expect(log?.summary).toContain('Switched on stock-transfers');
      const meta = log?.metadata as { before: string[]; after: string[] };
      expect(meta.before.sort()).toEqual(['marketing', 'stock-transfers']);
      expect(meta.after).toEqual(['marketing']);
    });

    it('will not let a store manager change what the organisation can reach', async () => {
      await request(server())
        .put('/config/capabilities')
        .set(auth(mgrT))
        .send({ disabled: [] })
        .expect(403);
    });

    it('refuses to switch off the spine', async () => {
      const res = await request(server())
        .put('/config/capabilities')
        .set(auth(hoT))
        .send({ disabled: ['settings/team'] })
        .expect(400);
      // Switching off the team screen removes the only screen that could switch
      // it back on, and nobody in the organisation could undo it.
      expect(String(res.body.message)).toContain('cannot be switched off');
    });

    it('refuses to switch off something the industry never included', async () => {
      const res = await request(server())
        .put('/config/capabilities')
        .set(auth(hoT))
        .send({ disabled: ['marketing', 'not-a-real-module'] })
        .expect(400);
      expect(String(res.body.message)).toContain('does not include');
    });

    it('takes the whole intended list, so two administrators cannot undo each other', async () => {
      // A delta ("turn this one off") loses to the last writer: the second
      // screen silently restores whatever the first removed.
      await request(server())
        .put('/config/capabilities')
        .set(auth(hoT))
        .send({ disabled: [] })
        .expect(200);
      await request(server()).get('/marketing/campaigns').set(auth(hoT)).expect(200);
    });
  });

  /* ================================================ 2. every screen reachable */

  describe('navigation completeness', () => {
    it('entitles every frontend route that has a page', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const navSource = path.join(
        __dirname,
        '..',
        '..',
        'frontend',
        'src',
        'lib',
        'navigation.ts',
      );
      if (!fs.existsSync(navSource)) return; // backend-only deployment

      const slugs = [...fs.readFileSync(navSource, 'utf8').matchAll(/^\s+slug: "([^"]+)"/gm)].map(
        (m) => m[1],
      );
      const res = await request(server()).get('/config/bootstrap').set(auth(hoT)).expect(200);
      const packNav: string[] = res.body.industry.packNavigation;

      // Éclat is the pack that carries the whole product, so every nav item the
      // frontend defines must be in it. A slug the frontend renders and the
      // pack omits is a link that 403s.
      for (const slug of slugs) expect(packNav).toContain(slug);
    });

    it('reaches each screen built in waves 1-3', async () => {
      // Not the pages — the APIs behind them. A page with no reachable API is
      // the same dead end as no page.
      const probes: [string, number[]][] = [
        ['/crm/sla/settings', [200]],
        ['/parties?archived=true&type=customer', [200]],
        ['/lead-tags', [200]],
        ['/staff-digest/preview', [200]],
        ['/reporting/scheduled', [200]],
        ['/import-mappings?entity=products', [200]],
        ['/stock/dead-stock/rules', [200, 404]],
        ['/hrms/payroll/week-offs', [200]],
        ['/loyalty/programme/settings', [200]],
        ['/messaging-routes', [200]],
        ['/adapters', [200]],
        ['/management/kpis', [200]],
      ];
      for (const [path, allowed] of probes) {
        const res = await request(server()).get(path).set(auth(hoT));
        expect({ path, status: res.status }).toEqual({
          path,
          status: allowed.includes(res.status) ? res.status : allowed[0],
        });
      }
    });
  });

  /* ====================================================== 3. role boundaries */

  describe('what each role may actually reach', () => {
    it('keeps a salesperson out of payroll administration', async () => {
      await request(server()).get('/hrms/payroll/week-offs').set(auth(repT)).expect(403);
      await request(server())
        .put('/hrms/payroll/compensation')
        .set(auth(repT))
        .send({ userId: 'u_cap_rep', amount: 999999 })
        .expect(403);
    });

    it('keeps a store manager out of what people are paid', async () => {
      // The one field a manager must not be able to set for their own team.
      await request(server())
        .put('/hrms/payroll/compensation')
        .set(auth(mgrT))
        .send({ userId: 'u_cap_rep', amount: 50000 })
        .expect(403);
    });

    it('never hands anybody a decrypted provider secret', async () => {
      for (const token of [repT, mgrT, hoT]) {
        const res = await request(server()).get('/adapters').set(auth(token)).expect(200);
        const body = JSON.stringify(res.body);
        expect(body).not.toMatch(/"accessToken"|"apiKey"|"secret":/);
      }
    });

    it('keeps a store manager out of another branch’s figures', async () => {
      // The West manager's scope is East only in this fixture; asking for West
      // is refused rather than quietly widened.
      await request(server())
        .get('/management/kpis')
        .query({ storeId: A.west })
        .set(auth(mgrT))
        .expect(403);
    });

    it('pins a salesperson to their own figures whatever they ask for', async () => {
      const res = await request(server())
        .get('/management/kpis')
        .query({ ownerId: 'u_cap_mgr' })
        .set(auth(repT))
        .expect(403);
      expect(String(res.body.message)).toContain('your own');

      const own = await request(server()).get('/management/kpis').set(auth(repT)).expect(200);
      // Pinned on the server, not hidden in the UI.
      expect(own.body.scope.ownerId).toBe('u_cap_rep');
    });
  });

  /* ========================================================= 4. the figures */

  describe('the management view', () => {
    beforeAll(async () => {
      // 1,200 leads: above any ordinary page limit, so a capped count is
      // visibly wrong rather than plausibly wrong.
      const now = new Date();
      await prisma.lead.createMany({
        data: Array.from({ length: BULK_LEADS }, (_, i) => ({
          organisationId: A.org,
          ref: `LD-CAP-${i}`,
          storeId: i % 2 === 0 ? A.east : A.west,
          customerName: `Bulk ${i}`,
          source: (i % 3 === 0 ? 'whatsapp' : 'walk_in') as never,
          outcome: i % 10 === 0 ? 'won' : 'open',
          ownerId: 'u_cap_rep',
          createdAt: now,
        })),
      });

      // One archived customer with a lead. Archived is not an active prospect.
      const archived = await prisma.party.create({
        data: {
          organisationId: A.org,
          storeId: A.east,
          name: 'Asked To Be Left Alone',
          phone: '9876511111',
          types: ['customer'],
          archivedAt: new Date(),
          archiveReason: 'Asked not to be contacted',
        },
      });
      await prisma.lead.create({
        data: {
          organisationId: A.org,
          ref: 'LD-CAP-ARCHIVED',
          storeId: A.east,
          partyId: archived.id,
          customerName: archived.name,
          source: 'walk_in' as never,
          ownerId: 'u_cap_rep',
        },
      });
    }, 120_000);

    it('counts every row, not the first page of them', async () => {
      const res = await request(server()).get('/management/kpis').set(auth(hoT)).expect(200);
      // 1,200 — not 100, not 1,000. A figure derived from a paginated list
      // stops moving at exactly the point the business is big enough to care.
      expect(res.body.leads.total).toBe(BULK_LEADS);
    });

    it('does not count an archived customer as an active prospect', async () => {
      const res = await request(server()).get('/management/kpis').set(auth(hoT)).expect(200);
      // The archived lead exists in the table and is excluded from the figure.
      const all = await prisma.lead.count({ where: { organisationId: A.org } });
      expect(all).toBe(BULK_LEADS + 1);
      expect(res.body.leads.total).toBe(BULK_LEADS);
    });

    it('says which clock decided the days, and that the branches disagreed', async () => {
      const res = await request(server()).get('/management/kpis').set(auth(hoT)).expect(200);
      // 25 hours apart: there is no single correct answer, so one is chosen and
      // said out loud rather than applied silently.
      expect(res.body.window.ambiguous).toBe(true);
      expect(res.body.window.zonesInScope.sort()).toEqual([EAST_TZ, WEST_TZ].sort());
      expect(res.body.window.resolvedBy).toBe('organisation_default');
      expect(res.body.window.timezone).toBe(EAST_TZ);
    });

    it('stops calling it ambiguous once one branch is chosen', async () => {
      const res = await request(server())
        .get('/management/kpis')
        .query({ storeId: A.west })
        .set(auth(hoT))
        .expect(200);
      expect(res.body.window.ambiguous).toBe(false);
      expect(res.body.window.resolvedBy).toBe('single_store');
      expect(res.body.window.timezone).toBe(WEST_TZ);
    });

    it('honours an explicitly requested timezone', async () => {
      const res = await request(server())
        .get('/management/kpis')
        .query({ timezone: 'Europe/London' })
        .set(auth(hoT))
        .expect(200);
      expect(res.body.window.timezone).toBe('Europe/London');
      expect(res.body.window.resolvedBy).toBe('requested');
      expect(res.body.window.ambiguous).toBe(false);
    });

    it('refuses a timezone the server does not recognise', async () => {
      await request(server())
        .get('/management/kpis')
        .query({ timezone: 'Middle/Earth' })
        .set(auth(hoT))
        .expect(400);
    });

    it('refuses a range too long to answer in one request', async () => {
      await request(server())
        .get('/management/kpis')
        .query({ from: '2000-01-01', to: '2026-01-01' })
        .set(auth(hoT))
        .expect(400);
    });

    it('reports a ratio with no denominator as unavailable, never as 0%', async () => {
      const res = await request(server()).get('/management/kpis').set(auth(hoT)).expect(200);
      // Nobody visited in the window, so the visit-to-sale question cannot be
      // asked. A branch that converted none of forty visits and one that had no
      // visitors are different Tuesdays.
      expect(res.body.floor.visits).toBe(0);
      expect(res.body.floor.visitToSale.value).toBeNull();
      expect(res.body.floor.visitToSale.denominator).toBe(0);
    });

    it('shows the working behind every ratio it can compute', async () => {
      const res = await request(server()).get('/management/kpis').set(auth(hoT)).expect(200);
      const bySource = res.body.conversion.bySource;
      expect(bySource.length).toBeGreaterThan(0);
      for (const row of bySource) {
        // A bare percentage cannot be checked against anything. The numerator
        // and denominator travel with it so the screen can show its arithmetic.
        expect(row.denominator).toBeGreaterThan(0);
        expect(row.numerator).toBeLessThanOrEqual(row.denominator);
        expect(row.value).toBe(Math.round((row.numerator / row.denominator) * 1000) / 10);
      }
    });

    it('keeps declared attribution apart from what a provider measured', async () => {
      const res = await request(server()).get('/management/kpis').set(auth(hoT)).expect(200);
      // Nothing has been measured, and the figure says 0 with a sentence
      // explaining that 0 measured is not evidence of organic traffic.
      expect(res.body.leads.measuredAdAttribution).toBe(0);
      expect(res.body.conversion.measured.denominator).toBe(0);
      expect(res.body.conversion.measured.value).toBeNull();
      expect(res.body.conversion.measured.note).toContain('NOT evidence of organic');
    });

    it('counts only what a provider measured as measured', async () => {
      const lead = await prisma.lead.findFirst({
        where: { organisationId: A.org, ref: 'LD-CAP-0' },
      });
      await prisma.attributionTouch.createMany({
        data: [
          {
            organisationId: A.org,
            leadId: lead!.id,
            channel: 'meta_ads',
            evidence: 'measured',
            externalAdId: 'ad-123',
            occurredAt: new Date(),
          },
          {
            organisationId: A.org,
            leadId: lead!.id,
            channel: 'meta_ads',
            // Somebody choosing "Meta Ads" from a dropdown at the counter. Not
            // the same fact, and adding it in would make "measured" partly a
            // guess.
            evidence: 'declared',
            externalAdId: 'ad-999',
            occurredAt: new Date(),
          },
        ],
      });

      const res = await request(server()).get('/management/kpis').set(auth(hoT)).expect(200);
      expect(res.body.leads.measuredAdAttribution).toBe(1);
    });

    it('does not report a month-end file as delivered when it only dry-ran', async () => {
      const res = await request(server()).get('/management/kpis').set(auth(hoT)).expect(200);
      const latest = res.body.operations.latestReport;
      // Null here, and when there IS one the `delivered` flag is the provider's
      // answer rather than the fact that a row exists.
      if (latest) expect(latest.delivered).toBe(latest.status === 'sent');
      else expect(latest).toBeNull();
    });

    it('answers "you have no branch" rather than a page of zeroes', async () => {
      const orphan = await prisma.user.create({
        data: {
          id: 'u_cap_orphan',
          email: 'orphan.cap@cap-a.local',
          name: 'orphan',
          role: 'salesperson' as never,
          passwordHash: await bcrypt.hash(PASSWORD, 10),
          isActive: true,
          approvalStatus: 'approved',
          organisationId: A.org,
        },
      });
      const token = await login(orphan.email);
      const res = await request(server()).get('/management/kpis').set(auth(token)).expect(200);
      // Zeroes would read as "the business did nothing". It did not — this
      // person simply has no branch to report on.
      expect(res.body.scope.unavailable).toContain('not assigned to any branch');
      expect(res.body.leads).toBeUndefined();
    });

    it('scopes one tenant’s figures to that tenant', async () => {
      const res = await request(server()).get('/management/kpis').set(auth(hoBT)).expect(200);
      // B has no leads at all. If A's 1,200 leaked in, this would not be 0.
      expect(res.body.leads.total).toBe(0);
    });
  });

  /* ========================================================== 5. the export */

  describe('exporting the detail', () => {
    it('produces a workbook and records who took it', async () => {
      const res = await request(server())
        .get('/management/export/leads')
        .set(auth(hoT))
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (c: Buffer) => chunks.push(c));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(res.headers['content-type']).toContain('spreadsheetml');
      // PK — a real zip container. Nest serialises a bare Buffer as JSON, which
      // downloads as a file Excel refuses to open.
      expect((res.body as Buffer).subarray(0, 2).toString()).toBe('PK');

      const log = await prisma.auditLog.findFirst({
        where: { organisationId: A.org, action: 'management.kpi_export' },
        orderBy: { createdAt: 'desc' },
      });
      expect(log).toBeTruthy();
      expect(log?.summary).toContain('lead row(s)');
    });

    it('gives a salesperson only their own rows, and says so in the audit line', async () => {
      await request(server())
        .get('/management/export/leads')
        .set(auth(rep2T))
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (c: Buffer) => chunks.push(c));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      const log = await prisma.auditLog.findFirst({
        where: { organisationId: A.org, action: 'management.kpi_export', actorId: 'u_cap_rep2' },
        orderBy: { createdAt: 'desc' },
      });
      const meta = log?.metadata as { ownerScoped: string | null; rows: number };
      expect(meta.ownerScoped).toBe('u_cap_rep2');
      // rep2 owns none of the bulk leads, so the export is empty rather than
      // quietly containing somebody else's customers.
      expect(meta.rows).toBe(0);
    });
  });
});
