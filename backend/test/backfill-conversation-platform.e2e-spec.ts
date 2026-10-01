import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ConversationsService } from '../src/crm/conversations.service';
import { extractMetaReferral } from '../src/integrations/meta-referral';

/**
 * scripts/backfill-conversation-platform.mjs, run the way a person runs it: as
 * a script, against a database holding ad threads in every shape the app leaves
 * them in.
 *
 * The threads and their touches are made by the app itself (`ingestInbound` and
 * the assign command), not typed in here. The script's whole job is to find the
 * touch the app filed for a thread, and the app files it in different places:
 * under the customer, under the lead, moved when the thread is routed later.
 * A fixture typed by hand would only prove the script agrees with this file.
 * `sourcePlatform` is then blanked, which is all that separates these threads
 * from ones created before the column existed.
 *
 * FIXTURE, NOT LIVE META. The payload is the documented CTWA webhook shape with
 * invented ids.
 */
const PASSWORD = 'password123';

const A = { org: 'org_bcp_a', slug: 'bcp-a', store: 'store_bcp_a', ho: 'ho.bcp@bcp-a.local' };
const B = { org: 'org_bcp_b', slug: 'bcp-b' };

/** One advert, running on Instagram and on Facebook at once. Every tap below is on it. */
const AD = '120219990000001';
const INSTAGRAM = 'https://www.instagram.com/p/DdwKr6isgcO/';
const FACEBOOK = 'https://fb.me/2AbCdEfGh';
const MESSENGER = 'https://m.me/bcp-jewellers';

const BACKEND = join(__dirname, '..');
const SCRIPT = join(BACKEND, 'scripts', 'backfill-conversation-platform.mjs');

/**
 * Run the script as a child process. It inherits this suite's environment, so
 * it is on the database the app below is on and no other.
 */
function run(...args: string[]) {
  const child = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: BACKEND, env: process.env, encoding: 'utf8' });
  return { status: child.status, out: child.stdout, err: child.stderr };
}

/** The report line for one conversation. */
const lineFor = (out: string, conversationId: string) =>
  out.split(/\r?\n/).find((line) => line.includes(conversationId)) ?? '';

describe('Backfill of the platform an ad lead came from (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let conversations: ConversationsService;
  let token: string;

  /** Conversation ids, by the shape each thread is in. */
  const ids: Record<string, string> = {};

  /** One inbound Click-to-WhatsApp message. Returns the conversation it landed in. */
  async function tap(o: {
    org?: string;
    from: string;
    wamid: string;
    clickId: string | null;
    sourceUrl: string;
    storeId?: string;
  }) {
    const raw = {
      from: o.from,
      id: o.wamid,
      timestamp: '1757240000',
      type: 'text',
      text: { body: 'Saw your ad, is this available?' },
      referral: {
        source_url: o.sourceUrl,
        source_id: AD,
        source_type: 'ad',
        headline: 'Festive collection',
        ...(o.clickId ? { ctwa_clid: o.clickId } : {}),
      },
    };
    const result = await conversations.ingestInbound({
      organisationId: o.org ?? A.org,
      channel: 'whatsapp',
      externalThreadId: o.from,
      externalId: o.wamid,
      senderKind: 'whatsapp',
      senderValue: o.from,
      senderName: 'Asha Fixture',
      body: raw.text.body,
      payload: raw as never,
      adReferral: extractMetaReferral(raw),
      storeId: o.storeId ?? null,
    });
    return result.conversationId;
  }

  /** A person gives the thread its branch, which is when the app moves the touch to the lead. */
  const routeByHand = (conversationId: string) =>
    request(app.getHttpServer())
      .post(`/crm/conversations/${conversationId}/assign`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ storeId: A.store, handling: 'human', reason: 'Routed by hand' })
      .expect(201);

  /** What each of a thread's touches is filed under, oldest first. */
  async function filedUnder(conversationId: string) {
    const touches = await prisma.attributionTouch.findMany({
      where: { metadata: { path: ['conversationId'], equals: conversationId } },
      orderBy: { createdAt: 'asc' },
      select: { partyId: true, leadId: true },
    });
    return touches.map((t) => (t.leadId ? 'lead' : t.partyId ? 'customer' : 'nothing'));
  }

  /** Every conversation of both organisations, under the name it has in `ids`. */
  async function threads() {
    const rows = await prisma.conversation.findMany({
      where: { organisationId: { in: [A.org, B.org] } },
      select: { id: true, partyId: true, sourcePlatform: true, updatedAt: true },
    });
    const nameOf = (id: string) => Object.keys(ids).find((name) => ids[name] === id) ?? id;
    return Object.fromEntries(rows.map((row) => [nameOf(row.id), row]));
  }

  const platforms = async () =>
    Object.fromEntries(Object.entries(await threads()).map(([name, row]) => [name, row.sourcePlatform]));

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    conversations = app.get(ConversationsService);

    await teardown(prisma);

    await prisma.organisation.create({ data: { id: A.org, name: 'BCP A', slug: A.slug } });
    await prisma.store.create({ data: { id: A.store, name: 'Hyderabad', city: 'Hyderabad', organisationId: A.org } });
    await prisma.user.create({
      data: {
        email: A.ho, name: 'HO', role: 'head_office', passwordHash: await bcrypt.hash(PASSWORD, 10),
        isActive: true, approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.store, isPrimary: true } },
      },
    });
    await prisma.organisation.create({ data: { id: B.org, name: 'BCP B', slug: B.slug } });

    const login = await request(app.getHttpServer()).post('/auth/login').send({ email: A.ho, password: PASSWORD });
    token = login.body.token;

    // No branch on arrival: the touch is filed under the customer. Later the
    // same customer taps the advert again, this time on Facebook. That second
    // tap has its own touch on the same thread and must not be borrowed.
    ids.unrouted = await tap({ from: '919000000601', wamid: 'wamid.bcp.1', clickId: 'clk-bcp-1', sourceUrl: INSTAGRAM });
    await tap({ from: '919000000601', wamid: 'wamid.bcp.1b', clickId: 'clk-bcp-1b', sourceUrl: FACEBOOK });

    // A branch on arrival: the app opens a lead and files the touch under it,
    // with no customer on the touch at all.
    ids.routed = await tap({
      from: '919000000602', wamid: 'wamid.bcp.2', clickId: 'clk-bcp-2', sourceUrl: FACEBOOK, storeId: A.store,
    });

    // No branch on arrival, then routed by a person: the touch MOVES from the
    // customer to the lead that opens.
    ids.routedLater = await tap({
      from: '919000000603', wamid: 'wamid.bcp.3', clickId: 'clk-bcp-3', sourceUrl: 'https://instagram.com/reel/abc',
    });
    await routeByHand(ids.routedLater);

    // One person, two numbers, the same advert: the second number tapped it on
    // Facebook. The two customers are then merged. The merge command moves the
    // second one's threads and touches onto the first (advanced-crm.service.ts)
    // and the same two moves are made here, so one customer now holds two
    // touches for one advert.
    ids.twin = await tap({ from: '919000000604', wamid: 'wamid.bcp.4', clickId: 'clk-bcp-4', sourceUrl: FACEBOOK });
    const { unrouted, twin } = await threads();
    expect(twin.partyId && twin.partyId !== unrouted.partyId).toBeTruthy();
    const merge = { where: { organisationId: A.org, partyId: twin.partyId }, data: { partyId: unrouted.partyId } };
    await prisma.conversation.updateMany(merge);
    await prisma.attributionTouch.updateMany(merge);

    // A sender the app could not read as a number: the thread has no customer,
    // and with a branch its touch is on the lead.
    ids.noCustomer = await tap({
      from: 'unreadable-sender-bcp', wamid: 'wamid.bcp.5', clickId: 'clk-bcp-5', sourceUrl: MESSENGER, storeId: A.store,
    });

    // AMBIGUOUS. No click id, and the same advert tapped twice on one thread,
    // from Instagram and then from Facebook, with the thread routed in between
    // (which is what makes the app record the second tap as a touch of its
    // own). Nothing on record says which of the two opened the thread.
    ids.ambiguous = await tap({ from: '919000000606', wamid: 'wamid.bcp.6', clickId: null, sourceUrl: INSTAGRAM });
    await routeByHand(ids.ambiguous);
    await tap({ from: '919000000606', wamid: 'wamid.bcp.6b', clickId: null, sourceUrl: FACEBOOK });

    // No click id, and the only touch on file was recorded an hour after the
    // thread was created. The tap that opened it left no touch; this one is a
    // later tap on the same advert, and could be from the other platform.
    ids.laterTapOnly = await tap({ from: '919000000607', wamid: 'wamid.bcp.7', clickId: null, sourceUrl: INSTAGRAM });
    await prisma.conversation.update({
      where: { id: ids.laterTapOnly },
      data: { createdAt: new Date(Date.now() - 60 * 60_000) },
    });

    // An ad thread with no touch at all, which is how the demo seed writes them.
    ids.noTouch = (
      await prisma.conversation.create({
        data: { organisationId: A.org, channel: 'whatsapp', externalThreadId: 'bcp-no-touch', sourceAdId: AD },
        select: { id: true },
      })
    ).id;

    // A source_url whose host names no platform, and which carries a number.
    ids.unreadable = await tap({
      from: '919000000609', wamid: 'wamid.bcp.9', clickId: 'clk-bcp-9', sourceUrl: 'https://wa.me/919000000609',
    });

    ids.alreadySet = await tap({ from: '919000000610', wamid: 'wamid.bcp.10', clickId: 'clk-bcp-10', sourceUrl: INSTAGRAM });

    // Another organisation, with the same number, the same advert and the same
    // click id as the first thread above.
    ids.otherOrg = await tap({
      org: B.org, from: '919000000601', wamid: 'wamid.bcp.b1', clickId: 'clk-bcp-1', sourceUrl: INSTAGRAM,
    });

    // As if all of these predate the column. One was given a platform since,
    // and not the one its own touch names.
    await prisma.conversation.updateMany({
      where: { organisationId: { in: [A.org, B.org] } },
      data: { sourcePlatform: null },
    });
    await prisma.conversation.update({ where: { id: ids.alreadySet }, data: { sourcePlatform: 'facebook' } });
  }, 180_000);

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  it('the app really did leave the touches in these different places', async () => {
    expect(await filedUnder(ids.unrouted)).toEqual(['customer', 'customer']);
    expect(await filedUnder(ids.routed)).toEqual(['lead']);
    expect(await filedUnder(ids.routedLater)).toEqual(['lead']);
    expect(await filedUnder(ids.twin)).toEqual(['customer']);
    expect(await filedUnder(ids.noCustomer)).toEqual(['lead']);
    expect(await filedUnder(ids.ambiguous)).toEqual(['lead', 'lead']);
    expect(await filedUnder(ids.noTouch)).toEqual([]);

    const { unrouted, twin, noCustomer } = await threads();
    expect(twin.partyId).toBe(unrouted.partyId);
    expect(noCustomer.partyId).toBeNull();
  });

  it('a dry run names the database, shows the mapping and changes nothing', async () => {
    const before = await threads();
    const everyOrganisation = run();
    const oneOrganisation = run('--organisation', A.slug);

    expect(everyOrganisation.status).toBe(0);
    // Database name and host, and nothing else from the connection string.
    const db = new URL(process.env.DATABASE_URL as string);
    expect(everyOrganisation.out.split(/\r?\n/)[0]).toBe(`Database: ${db.pathname.slice(1)} on ${db.host}`);
    expect(everyOrganisation.out).not.toContain('://');
    expect(everyOrganisation.out).not.toContain('@');

    // With no organisation named it reports every one, and says which is which.
    expect(lineFor(everyOrganisation.out, ids.unrouted)).toMatch(/^\s+bcp-a\s.*-> INSTAGRAM \(www\.instagram\.com\)$/);
    expect(lineFor(everyOrganisation.out, ids.otherOrg)).toMatch(/^\s+bcp-b\s.*-> INSTAGRAM \(www\.instagram\.com\)$/);

    expect(oneOrganisation.out).not.toContain(ids.otherOrg);
    expect(oneOrganisation.out).toContain(
      'DRY RUN - nothing written. Would write 5 of 9: facebook 2, instagram 2, messenger 1.',
    );

    expect(await threads()).toEqual(before);
  });

  it('prints no database user or password, even when the database refuses the login', () => {
    // The same database, with a made-up login it will refuse. Prisma's own
    // error for that names the database user, which is how one could get printed.
    const refused = new URL(process.env.DATABASE_URL as string);
    refused.username = 'bcp_no_such_user';
    refused.password = 'bcp-not-a-password';
    const child = spawnSync(process.execPath, [SCRIPT], {
      cwd: BACKEND,
      env: { ...process.env, DATABASE_URL: refused.href },
      encoding: 'utf8',
    });

    expect(child.status).toBe(1);
    expect(child.stderr).toContain('Stopped:');
    expect(child.stdout + child.stderr).not.toContain('bcp_no_such_user');
    expect(child.stdout + child.stderr).not.toContain('bcp-not-a-password');
  });

  it('refuses to write unless one organisation is named', async () => {
    const before = await threads();

    const unnamed = run('--apply');
    expect(unnamed.status).toBe(1);
    expect(unnamed.err).toContain('--apply needs --organisation');

    const unknown = run('--apply', '--organisation', 'no-such-organisation');
    expect(unknown.status).toBe(1);
    expect(unknown.err).toContain('names 0 organisations');

    expect(await threads()).toEqual(before);
  });

  describe('--apply for one organisation', () => {
    let applied: ReturnType<typeof run>;

    beforeAll(() => {
      applied = run('--apply', '--organisation', A.slug);
    });

    it('gives each thread the platform of its own tap, and writes nothing else', async () => {
      expect(applied.status).toBe(0);
      expect(await platforms()).toEqual({
        unrouted: 'instagram',
        routed: 'facebook',
        routedLater: 'instagram',
        twin: 'facebook',
        noCustomer: 'messenger',
        // It could not tell which touch was theirs.
        ambiguous: null,
        laterTapOnly: null,
        noTouch: null,
        unreadable: null,
        // Its own touch says Instagram. Somebody had already recorded Facebook.
        alreadySet: 'facebook',
        otherOrg: null,
      });

      expect(lineFor(applied.out, ids.twin)).toMatch(/-> FACEBOOK \(fb\.me\) written$/);
      expect(applied.out).toContain('Written 5 of 9: facebook 2, instagram 2, messenger 1.');
      expect(applied.out).not.toContain(ids.otherOrg);
      expect(applied.out).not.toContain(ids.alreadySet);
    });

    it('says why each thread it left alone was left alone', () => {
      expect(lineFor(applied.out, ids.ambiguous)).toContain('left alone: 2 touches fit and they disagree');
      expect(lineFor(applied.out, ids.laterTapOnly)).toContain('left alone: no touch on file');
      expect(lineFor(applied.out, ids.noTouch)).toContain('left alone: no touch on file');
      expect(lineFor(applied.out, ids.unreadable)).toContain('left alone: its source_url names no platform (wa.me)');
      expect(applied.out).toContain('Left alone 4: ambiguous 1, no touch 2, unreadable 1.');
    });

    it('prints conversation ids, never a customer name or number', () => {
      const printed = applied.out + applied.err + run().out;
      expect(printed).not.toMatch(/9190000006\d\d/);
      expect(printed).not.toContain('Asha Fixture');
      expect(printed).not.toContain('unreadable-sender-bcp');
    });

    it('a second --apply changes nothing, and says so', async () => {
      const before = await threads();

      // By id this time: either names the organisation.
      const again = run('--apply', '--organisation', A.org);

      expect(again.status).toBe(0);
      expect(again.out).toContain('Written 0 of 4.');
      expect(await threads()).toEqual(before);
    });

    it('does not overwrite a platform somebody records while it is running', async () => {
      ids.setMeanwhile = await tap({
        from: '919000000611', wamid: 'wamid.bcp.11', clickId: 'clk-bcp-11', sourceUrl: INSTAGRAM,
      });
      await prisma.conversation.update({ where: { id: ids.setMeanwhile }, data: { sourcePlatform: null } });

      let out = '';
      let exited!: Promise<number | null>;
      // Somebody else's write, held open in a transaction. The script starts
      // inside it, so it reads the thread as still empty; the write commits
      // only once the script has done that read.
      await prisma.$transaction(
        async (tx) => {
          await tx.conversation.update({ where: { id: ids.setMeanwhile }, data: { sourcePlatform: 'facebook' } });

          const child = spawn(process.execPath, [SCRIPT, '--apply', '--organisation', A.slug], {
            cwd: BACKEND,
            env: process.env,
          });
          exited = new Promise((resolve) => child.on('close', resolve));
          const hasRead = new Promise<void>((resolve) => {
            child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
              out += chunk;
              if (out.includes('with no platform recorded')) resolve();
            });
          });
          await Promise.race([hasRead, exited]);
        },
        { timeout: 20_000 },
      );

      expect(await exited).toBe(0);
      expect(lineFor(out, ids.setMeanwhile)).toContain('left alone: a platform was set while this ran');
      expect(out).toContain('Written 0 of 5.');
      // The closing lines speak for every thread left alone, and this one is
      // not empty. So they say what this run did, not what the threads hold.
      expect(out).toContain('Conversations left alone were not written by this run.');
      expect(out).not.toContain('keep sourcePlatform NULL');
      expect((await platforms()).setMeanwhile).toBe('facebook');
    });
  });
});

async function teardown(prisma: PrismaService) {
  for (const org of [A.org, B.org]) {
    await prisma.conversationRoutingConflict.deleteMany({ where: { organisationId: org } });
    await prisma.attributionTouch.deleteMany({ where: { organisationId: org } });
    await prisma.message.deleteMany({ where: { organisationId: org } });
    await prisma.conversation.deleteMany({ where: { organisationId: org } });
    await prisma.activityEvent.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.leadFollowUp.deleteMany({ where: { lead: { organisationId: org } } }).catch(() => undefined);
    await prisma.lead.deleteMany({ where: { organisationId: org } });
    await prisma.contactPoint.deleteMany({ where: { organisationId: org } });
    await prisma.party.deleteMany({ where: { organisationId: org } });
    await prisma.auditLog.deleteMany({ where: { organisationId: org } });
    await prisma.userStore.deleteMany({ where: { store: { organisationId: org } } });
    await prisma.user.deleteMany({ where: { organisationId: org } });
    await prisma.store.deleteMany({ where: { organisationId: org } });
    await prisma.organisation.deleteMany({ where: { id: org } });
  }
}
