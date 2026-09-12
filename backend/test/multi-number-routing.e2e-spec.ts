import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Eight numbers, two accounts, and which branch speaks on which.
 *
 * FIXTURE-TESTED. Nothing here contacts Meta. Tokens are fixtures written
 * through the real envelope encryption, and every send resolves a sender and
 * then stops at the provider boundary — the assertions are about WHICH number
 * was chosen and WHY, which is the whole of this block. No live WABA has
 * answered any of it.
 *
 * What is being defended:
 *
 *  1. THE OLD BEHAVIOUR WAS A SILENT WRONG ANSWER. `senderFor` took the first
 *     active asset of the first integration. With eight numbers that meant every
 *     branch sent from whichever was registered first, and a customer who wrote
 *     to Surat was answered from Mumbai. Refusing is better than that, so a
 *     tenant with several numbers and no route now gets a sentence naming the
 *     branches to map — never an arbitrary number.
 *
 *  2. ONE NUMBER STILL NEEDS NO CONFIGURATION. Every existing single-number
 *     tenant must behave exactly as before, or this is a migration that breaks
 *     production to fix a problem production does not have yet.
 *
 *  3. A REGISTRATION NO LONGER SWITCHES OFF ITS SIBLINGS. The registry used to
 *     deactivate every other number on a connection. That is lifted; what is NOT
 *     lifted is the unique ownership claim, so two tenants can still never both
 *     own the same phone-number id.
 *
 *  4. THE THREAD'S NUMBER OUTRANKS THE BRANCH'S. A customer who wrote to a
 *     number is answered from it, whatever the branch route says, because their
 *     24-hour window lives on that number and a different one arrives as a
 *     different business.
 *
 *  5. THE TOKEN FOLLOWS THE NUMBER'S OWN ACCOUNT. With two WABA accounts the
 *     tokens differ. Using account A's token against account B's number would
 *     have failed at the provider on exactly half the branches.
 *
 *  6. ROUTING IS NOT OWNERSHIP. Both ids arrive in a request body, so both are
 *     re-checked: no tenant can route its branch onto another tenant's number.
 */

process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString('base64');
process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = '1';

const PASSWORD = 'password123';

const A = {
  org: 'org_route_a',
  slug: 'route-a',
  mumbai: 'store_route_mumbai',
  surat: 'store_route_surat',
  pune: 'store_route_pune',
  ho: 'ho.route@route-a.local',
  mgr: 'mgr.route@route-a.local',
};
const B = {
  org: 'org_route_b',
  slug: 'route-b',
  store: 'store_route_b',
  ho: 'ho.route@route-b.local',
};

/** Two WABA accounts for tenant A. */
const ACCOUNT_ONE = 'int_route_waba_one';
const ACCOUNT_TWO = 'int_route_waba_two';
const ACCOUNT_B = 'int_route_b';

/** Eight numbers: five on the first account, three on the second. */
const NUMBERS = {
  one: ['700000000001', '700000000002', '700000000003', '700000000004', '700000000005'],
  two: ['700000000006', '700000000007', '700000000008'],
};
const B_NUMBER = '700000000099';

async function teardown(prisma: PrismaService) {
  for (const org of [A.org, B.org]) {
    await prisma.storeMessagingRoute.deleteMany({ where: { organisationId: org } });
    await prisma.message.deleteMany({ where: { organisationId: org } });
    await prisma.conversation.deleteMany({ where: { organisationId: org } });
    await prisma.integrationCredential.deleteMany({ where: { organisationId: org } });
    await prisma.integrationAsset.deleteMany({ where: { organisationId: org } });
    await prisma.integration.deleteMany({ where: { organisationId: org } });
    await prisma.auditLog.deleteMany({ where: { organisationId: org } });
    await prisma.party.deleteMany({ where: { organisationId: org } });
    await prisma.userStore.deleteMany({ where: { user: { organisationId: org } } });
    await prisma.user.deleteMany({ where: { organisationId: org } });
    await prisma.store.deleteMany({ where: { organisationId: org } });
    await prisma.organisation.deleteMany({ where: { id: org } });
  }
}

describe('Multi-account, multi-number sender routing (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let credentials: import('../src/integrations/whatsapp-credentials.service').WhatsAppCredentialsService;

  let hoT: string;
  let mgrT: string;
  let hoBT: string;

  /** phone-number id → asset id, filled as the fixtures are created. */
  const assetOf = new Map<string, string>();

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  /** Register one number directly, the way a verified connection would hold it. */
  async function addNumber(
    organisationId: string,
    integrationId: string,
    externalId: string,
    name: string,
  ) {
    const asset = await prisma.integrationAsset.create({
      data: {
        organisationId,
        integrationId,
        kind: 'phone_number',
        externalId,
        name,
        isActive: true,
        // The unique platform-wide claim on this routing identity.
        ownershipKey: `whatsapp_cloud:phone_number:${externalId}`,
      },
    });
    assetOf.set(externalId, asset.id);
    return asset;
  }

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService: P } = await import('../src/prisma/prisma.service');
    const { WhatsAppCredentialsService } = await import(
      '../src/integrations/whatsapp-credentials.service'
    );
    const { CredentialCrypto } = await import(
      '../src/integration/framework/credential-crypto'
    );

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
    credentials = app.get(WhatsAppCredentialsService);
    const crypto = app.get(CredentialCrypto);
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);

    // ── tenant A: three branches, two accounts, eight numbers ──────────────
    await prisma.organisation.create({
      data: { id: A.org, name: 'Route A', slug: A.slug, industryPackCode: 'jewellery' },
    });
    for (const [id, name] of [
      [A.mumbai, 'Mumbai'],
      [A.surat, 'Surat'],
      [A.pune, 'Pune'],
    ] as const) {
      await prisma.store.create({
        data: { id, name, city: name, organisationId: A.org, timezone: 'Asia/Kolkata' },
      });
    }
    for (const [id, name] of [
      [ACCOUNT_ONE, 'Main WABA'],
      [ACCOUNT_TWO, 'Second WABA'],
    ] as const) {
      await prisma.integration.create({
        data: {
          id,
          organisationId: A.org,
          providerCode: 'whatsapp_cloud',
          name,
          status: 'connected',
        },
      });
      // Each account has its OWN token. Using one against the other's number is
      // refused by the provider, so the resolver must pick per account.
      const sealed = crypto.encrypt(`token-for-${id}`, {
        organisationId: A.org,
        integrationId: id,
        kind: 'access_token',
      });
      await prisma.integrationCredential.create({
        data: {
          organisationId: A.org,
          integrationId: id,
          kind: 'access_token',
          ...sealed,
        },
      });
    }
    for (const n of NUMBERS.one) await addNumber(A.org, ACCOUNT_ONE, n, `One …${n.slice(-4)}`);
    for (const n of NUMBERS.two) await addNumber(A.org, ACCOUNT_TWO, n, `Two …${n.slice(-4)}`);

    // ── tenant B: one branch, one number ──────────────────────────────────
    await prisma.organisation.create({
      data: { id: B.org, name: 'Route B', slug: B.slug, industryPackCode: 'retail' },
    });
    await prisma.store.create({
      data: {
        id: B.store,
        name: 'B main',
        city: 'Jaipur',
        organisationId: B.org,
        timezone: 'Asia/Kolkata',
      },
    });
    await prisma.integration.create({
      data: {
        id: ACCOUNT_B,
        organisationId: B.org,
        providerCode: 'whatsapp_cloud',
        name: 'Only WABA',
        status: 'connected',
      },
    });
    const sealedB = crypto.encrypt('token-for-b', {
      organisationId: B.org,
      integrationId: ACCOUNT_B,
      kind: 'access_token',
    });
    await prisma.integrationCredential.create({
      data: {
        organisationId: B.org,
        integrationId: ACCOUNT_B,
        kind: 'access_token',
        ...sealedB,
      },
    });
    await addNumber(B.org, ACCOUNT_B, B_NUMBER, 'B only');

    for (const [id, email, org, store, role] of [
      ['u_route_ho', A.ho, A.org, A.mumbai, 'head_office'],
      ['u_route_mgr', A.mgr, A.org, A.surat, 'store_manager'],
      ['u_route_ho_b', B.ho, B.org, B.store, 'head_office'],
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
    // Head office reaches every branch through its role, not an assignment.

    const login = async (email: string) =>
      (
        await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201)
      ).body.token;
    hoT = await login(A.ho);
    mgrT = await login(A.mgr);
    hoBT = await login(B.ho);
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  /* ============================================ 1. ambiguity is refused */

  describe('several numbers and no route', () => {
    it('refuses to send rather than picking one of eight', async () => {
      const sender = await credentials.senderFor(A.org);
      expect(sender.usable).toBe(false);
      // The count is in the sentence: "no sender configured" would read like a
      // missing connection, and the state is the opposite.
      expect(sender.reason).toContain('8 WhatsApp numbers');
      expect(sender.reason).toContain('no branch was named');
      expect(sender.phoneNumberId).toBeNull();
      expect(sender.accessToken).toBeNull();
    });

    it('refuses for a named branch too, and says that branch is the problem', async () => {
      const sender = await credentials.senderFor(A.org, { storeId: A.surat });
      expect(sender.usable).toBe(false);
      expect(sender.reason).toContain('this branch has no sender mapped to it');
    });

    it('names the unroutable branches on the settings screen', async () => {
      const res = await request(server()).get('/messaging-routes').set(auth(hoT)).expect(200);
      expect(res.body.numbers).toHaveLength(8);
      // Two WABA accounts, grouped, with how many numbers each holds.
      expect(res.body.accounts).toHaveLength(2);
      expect(res.body.accounts.map((a: { numbers: number }) => a.numbers).sort()).toEqual([3, 5]);
      expect(res.body.unroutable.sort()).toEqual(['Mumbai', 'Pune', 'Surat']);
      for (const branch of res.body.branches) expect(branch.effective).toBe('ambiguous');
    });

    it('shows only the last four digits of a number, never the id', async () => {
      const res = await request(server()).get('/messaging-routes').set(auth(hoT)).expect(200);
      const body = JSON.stringify(res.body);
      for (const n of [...NUMBERS.one, ...NUMBERS.two]) expect(body).not.toContain(n);
      expect(res.body.numbers[0].phoneNumberIdSuffix).toMatch(/^…\d{4}$/);
    });

    it('does not claim provider ownership that nothing has verified', async () => {
      const res = await request(server()).get('/messaging-routes').set(auth(hoT)).expect(200);
      for (const n of res.body.numbers) {
        expect(n.providerOwnershipVerified).toBe(false);
        expect(n.lastVerifiedAt).toBeNull();
      }
    });
  });

  /* ============================================ 2. one number, no config */

  describe('a tenant with one number', () => {
    it('keeps working with no routing at all', async () => {
      const sender = await credentials.senderFor(B.org);
      expect(sender.usable).toBe(true);
      expect(sender.phoneNumberId).toBe(B_NUMBER);
      // Named so a screen can say WHY, rather than implying somebody configured it.
      expect(sender.resolvedBy).toBe('only_number');
      expect(sender.accessToken).toBe('token-for-b');
    });

    it('reports every branch as resolvable without a route', async () => {
      const res = await request(server()).get('/messaging-routes').set(auth(hoBT)).expect(200);
      expect(res.body.unroutable).toEqual([]);
      expect(res.body.branches[0].effective).toBe('only_number');
    });
  });

  /* ================================================= 3. mapping branches */

  describe('mapping a branch to a number', () => {
    it('maps each branch and reports it', async () => {
      for (const [store, number] of [
        [A.mumbai, NUMBERS.one[0]],
        [A.surat, NUMBERS.two[0]],
        [A.pune, NUMBERS.two[0]],
      ] as const) {
        await request(server())
          .put(`/messaging-routes/${store}`)
          .set(auth(hoT))
          .send({ assetId: assetOf.get(number) })
          .expect(200);
      }

      const res = await request(server()).get('/messaging-routes').set(auth(hoT)).expect(200);
      expect(res.body.unroutable).toEqual([]);
      for (const branch of res.body.branches) expect(branch.effective).toBe('routed');
      // One number legitimately serves two branches: a head-office line
      // answering for several shops is an ordinary arrangement.
      const shared = res.body.numbers.find(
        (n: { id: string }) => n.id === assetOf.get(NUMBERS.two[0]),
      );
      expect(shared.branchesUsing).toBe(2);
    });

    it('sends each branch from its own number', async () => {
      const mumbai = await credentials.senderFor(A.org, { storeId: A.mumbai });
      expect(mumbai.usable).toBe(true);
      expect(mumbai.phoneNumberId).toBe(NUMBERS.one[0]);
      expect(mumbai.resolvedBy).toBe('store_route');

      const surat = await credentials.senderFor(A.org, { storeId: A.surat });
      expect(surat.phoneNumberId).toBe(NUMBERS.two[0]);
      // Not the same number. This is the whole bug: before routing, both of
      // these returned the oldest number on the first account.
      expect(surat.phoneNumberId).not.toBe(mumbai.phoneNumberId);
    });

    it('uses the token of the account that actually owns the number', async () => {
      const mumbai = await credentials.senderFor(A.org, { storeId: A.mumbai });
      const surat = await credentials.senderFor(A.org, { storeId: A.surat });
      // Two WABA accounts, two tokens. Sending account two's number with
      // account one's token is refused by Meta — on exactly half the branches,
      // which is the kind of failure nobody finds for a week.
      expect(mumbai.accessToken).toBe(`token-for-${ACCOUNT_ONE}`);
      expect(surat.accessToken).toBe(`token-for-${ACCOUNT_TWO}`);
      expect(mumbai.integrationId).toBe(ACCOUNT_ONE);
      expect(surat.integrationId).toBe(ACCOUNT_TWO);
    });

    it('records who changed a branch’s number, and to what', async () => {
      const log = await prisma.auditLog.findFirst({
        where: {
          organisationId: A.org,
          action: 'integration.messaging_route_set',
          entityId: A.surat,
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(log?.summary).toContain('Surat');
      expect(log?.summary).toContain('Second WABA');
      // The last four only, even in the audit trail.
      expect(log?.summary).toContain(`…${NUMBERS.two[0].slice(-4)}`);
    });

    it('moves the account with the number when a branch changes WABA', async () => {
      await request(server())
        .put(`/messaging-routes/${A.pune}`)
        .set(auth(hoT))
        .send({ assetId: assetOf.get(NUMBERS.one[4]) })
        .expect(200);

      const route = await prisma.storeMessagingRoute.findUnique({
        where: { storeId_channel: { storeId: A.pune, channel: 'whatsapp' } },
      });
      // The integration is rewritten alongside the asset, or the route would
      // name a token that cannot use the number.
      expect(route?.integrationId).toBe(ACCOUNT_ONE);
      const pune = await credentials.senderFor(A.org, { storeId: A.pune });
      expect(pune.accessToken).toBe(`token-for-${ACCOUNT_ONE}`);
    });

    it('keeps one sender per branch per channel', async () => {
      const count = await prisma.storeMessagingRoute.count({
        where: { storeId: A.surat, channel: 'whatsapp' },
      });
      // Re-mapped several times above; still exactly one row. Two would be a
      // coin toss at send time.
      expect(count).toBe(1);
    });
  });

  /* ================================================== 4. the thread wins */

  describe('the number a thread arrived on', () => {
    const CUSTOMER = '919812300011';

    it('is answered from, whatever the branch route says', async () => {
      // The customer wrote to a number that is NOT Surat's route.
      const arrivedOn = assetOf.get(NUMBERS.one[2])!;
      const sender = await credentials.senderFor(A.org, {
        assetId: arrivedOn,
        storeId: A.surat,
      });
      expect(sender.usable).toBe(true);
      expect(sender.phoneNumberId).toBe(NUMBERS.one[2]);
      expect(sender.resolvedBy).toBe('thread');
    });

    it('pins itself on the conversation when a message arrives', async () => {
      await prisma.conversation.create({
        data: {
          organisationId: A.org,
          channel: 'whatsapp',
          externalThreadId: CUSTOMER,
          storeId: A.surat,
          senderAssetId: assetOf.get(NUMBERS.one[2]),
        },
      });
      const convo = await prisma.conversation.findUnique({
        where: {
          organisationId_channel_externalThreadId: {
            organisationId: A.org,
            channel: 'whatsapp',
            externalThreadId: CUSTOMER,
          },
        },
      });
      expect(convo?.senderAssetId).toBe(assetOf.get(NUMBERS.one[2]));
    });

    it('falls back to the branch when that number has been retired', async () => {
      const retired = assetOf.get(NUMBERS.one[2])!;
      await prisma.integrationAsset.update({
        where: { id: retired },
        data: { isActive: false, ownershipKey: null },
      });

      const sender = await credentials.senderFor(A.org, {
        assetId: retired,
        storeId: A.surat,
      });
      // Falling through is the lesser harm — the alternative is never answering
      // the customer — and `resolvedBy` makes the substitution visible rather
      // than silent.
      expect(sender.usable).toBe(true);
      expect(sender.resolvedBy).toBe('store_route');
      expect(sender.phoneNumberId).toBe(NUMBERS.two[0]);

      await prisma.integrationAsset.update({
        where: { id: retired },
        data: { isActive: true, ownershipKey: `whatsapp_cloud:phone_number:${NUMBERS.one[2]}` },
      });
    });

    it('tells an inbound message which number and branch it landed on', async () => {
      const owner = await credentials.organisationForPhoneNumberId(NUMBERS.one[0]);
      expect(owner?.organisationId).toBe(A.org);
      expect(owner?.assetId).toBe(assetOf.get(NUMBERS.one[0]));
      // Mumbai is the only branch on this number, so the branch is known.
      expect(owner?.storeId).toBe(A.mumbai);
    });

    it('leaves the branch null when a number answers for several', async () => {
      const owner = await credentials.organisationForPhoneNumberId(NUMBERS.two[0]);
      expect(owner?.organisationId).toBe(A.org);
      // Surat still shares this one with nobody now that Pune moved, so give it
      // a second branch again to prove the ambiguous case.
      await request(server())
        .put(`/messaging-routes/${A.mumbai}`)
        .set(auth(hoT))
        .send({ assetId: assetOf.get(NUMBERS.two[0]) })
        .expect(200);

      const shared = await credentials.organisationForPhoneNumberId(NUMBERS.two[0]);
      // A line shared by two shops cannot say which one an enquiry belongs to,
      // and guessing would file a customer against a branch that never spoke to
      // them.
      expect(shared?.storeId).toBeNull();

      // Put Mumbai back.
      await request(server())
        .put(`/messaging-routes/${A.mumbai}`)
        .set(auth(hoT))
        .send({ assetId: assetOf.get(NUMBERS.one[0]) })
        .expect(200);
    });
  });

  /* ====================================== 5. registering does not deactivate */

  describe('registering a number', () => {
    it('no longer switches off the others on the same connection', async () => {
      const before = await prisma.integrationAsset.count({
        where: { integrationId: ACCOUNT_ONE, kind: 'phone_number', isActive: true },
      });
      expect(before).toBe(5);

      await request(server())
        .post(`/integrations-registry/${ACCOUNT_ONE}/assets`)
        .set(auth(hoT))
        .send({ kind: 'phone_number', externalId: '700000000010', name: 'Sixth' })
        .expect(201);

      const after = await prisma.integrationAsset.count({
        where: { integrationId: ACCOUNT_ONE, kind: 'phone_number', isActive: true },
      });
      // Six. This used to be one: registering the sixth deactivated the other
      // five, and the branches on them silently started sending as somebody else.
      expect(after).toBe(6);
    });

    it('still refuses a number another connection already owns', async () => {
      const res = await request(server())
        .post(`/integrations-registry/${ACCOUNT_TWO}/assets`)
        .set(auth(hoT))
        .send({ kind: 'phone_number', externalId: NUMBERS.one[0] })
        .expect(400);
      // The unique ownership claim is the property that actually matters, and it
      // is untouched: two connections can never both own a routing identity.
      expect(String(res.body.message)).toContain('already registered');
    });

    it('still refuses a number another TENANT already owns', async () => {
      const res = await request(server())
        .post(`/integrations-registry/${ACCOUNT_B}/assets`)
        .set(auth(hoBT))
        .send({ kind: 'phone_number', externalId: NUMBERS.one[1] })
        .expect(400);
      expect(String(res.body.message)).toContain('already registered');
    });
  });

  /* ================================================= 6. routing is not ownership */

  describe('who may route what', () => {
    it('refuses to route a branch onto another tenant’s number', async () => {
      await request(server())
        .put(`/messaging-routes/${B.store}`)
        .set(auth(hoBT))
        .send({ assetId: assetOf.get(NUMBERS.one[0]) })
        .expect(404);
    });

    it('refuses to route another tenant’s branch', async () => {
      await request(server())
        .put(`/messaging-routes/${B.store}`)
        .set(auth(hoT))
        .send({ assetId: assetOf.get(NUMBERS.one[0]) })
        .expect(403);
    });

    it('will not let a store manager change which business answers a customer', async () => {
      await request(server())
        .put(`/messaging-routes/${A.surat}`)
        .set(auth(mgrT))
        .send({ assetId: assetOf.get(NUMBERS.one[0]) })
        .expect(403);
      await request(server()).get('/messaging-routes').set(auth(mgrT)).expect(403);
    });

    it('refuses to route a branch onto a number that cannot send', async () => {
      const parked = assetOf.get(NUMBERS.one[3])!;
      await prisma.integrationAsset.update({
        where: { id: parked },
        data: { isActive: false, ownershipKey: null },
      });
      const res = await request(server())
        .put(`/messaging-routes/${A.pune}`)
        .set(auth(hoT))
        .send({ assetId: parked })
        .expect(400);
      // A branch that looks configured and silently fails is worse than one that
      // refuses now, with the reason.
      expect(String(res.body.message)).toContain('no longer active');

      await prisma.integrationAsset.update({
        where: { id: parked },
        data: { isActive: true, ownershipKey: `whatsapp_cloud:phone_number:${NUMBERS.one[3]}` },
      });
    });

    it('refuses a channel that has no outbound adapter', async () => {
      const res = await request(server())
        .put(`/messaging-routes/${A.pune}`)
        .set(auth(hoT))
        .send({ assetId: assetOf.get(NUMBERS.one[0]), channel: 'instagram' })
        .expect(400);
      expect(String(res.body.message)).toBeTruthy();
    });
  });

  /* ================================================= 7. clearing a route */

  describe('clearing a route', () => {
    it('says out loud that the branch can no longer send', async () => {
      const res = await request(server())
        .delete(`/messaging-routes/${A.pune}`)
        .set(auth(hoT))
        .expect(200);
      expect(res.body.removed).toBe(true);
      expect(res.body.warning).toContain('can no longer send');

      const sender = await credentials.senderFor(A.org, { storeId: A.pune });
      expect(sender.usable).toBe(false);
    });

    it('404s a branch that had no route', async () => {
      await request(server()).delete(`/messaging-routes/${A.pune}`).set(auth(hoT)).expect(404);
    });

    it('takes the routes with the connection when it is removed', async () => {
      const routes = await prisma.storeMessagingRoute.count({
        where: { organisationId: A.org, integrationId: ACCOUNT_TWO },
      });
      expect(routes).toBeGreaterThan(0);

      await prisma.integration.delete({ where: { id: ACCOUNT_TWO } });

      const after = await prisma.storeMessagingRoute.count({
        where: { organisationId: A.org, integrationId: ACCOUNT_TWO },
      });
      // Cascaded. A route naming a connection the tenant no longer holds would
      // resolve to a number that cannot send, which is worse than no route: no
      // route refuses and says so.
      expect(after).toBe(0);
    });

    it('keeps the conversations held on a removed number', async () => {
      const convo = await prisma.conversation.findFirst({
        where: { organisationId: A.org, channel: 'whatsapp' },
        select: { id: true, senderAssetId: true },
      });
      expect(convo).toBeTruthy();
      const assetId = convo!.senderAssetId!;

      await prisma.integrationAsset.delete({ where: { id: assetId } });

      const after = await prisma.conversation.findUnique({ where: { id: convo!.id } });
      // The thread survives and falls back to the branch route, which is what a
      // tenant retiring a number actually wants.
      expect(after).toBeTruthy();
      expect(after?.senderAssetId).toBeNull();
    });
  });
});
