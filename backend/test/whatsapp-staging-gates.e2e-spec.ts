import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { createHmac } from 'crypto';

/**
 * The three gates a WhatsApp staging test depends on, exercised locally.
 *
 * A live staging validation needs a Meta portal, a verified recipient and a
 * physical phone. None of that is available here, and none of it is simulated —
 * see docs/META-STAGING-TEST-CHECKLIST.md for what remains blocked. What CAN be
 * proven without any of it is that the doors themselves work, and each of these
 * three had no coverage at all:
 *
 *  1. THE HANDSHAKE SUCCEEDS with the right token. Only the refusal was tested,
 *     so a bug that refused everything would have passed. The comparison is also
 *     constant-time now, like the Lead Ads handshake beside it — `===` returns
 *     as soon as two bytes differ, and this endpoint is public.
 *
 *  2. THE SIGNATURE GATE FAILS CLOSED in production. With no app secret
 *     configured the service refuses in production and accepts in development;
 *     only the development half was covered, which is the half that does not
 *     matter.
 *
 *  3. THE ALLOWLIST DOOR HOLDS on the real service. The existing allowlist tests
 *     construct WhatsAppService by hand with a stub ConfigService — so they
 *     prove the function, not the wiring. This resolves the instance the
 *     application actually uses, from the container, with the real config.
 *
 * Every number here is a documentation-range test number. Nothing in this file
 * is a real recipient, and nothing in it sends anything.
 */

/** Meta's own documentation range. Not routable, not anybody's. */
const ALLOWED = '919000000001';
const NOT_ALLOWED = '919000000002';
const VERIFY_TOKEN = 'staging-gate-spec-verify-token';
const APP_SECRET = 'staging-gate-spec-app-secret';

describe('WhatsApp staging gates (e2e)', () => {
  let app: INestApplication;
  let whatsapp: import('../src/integrations/whatsapp.service').WhatsAppService;
  const server = () => app.getHttpServer();

  const previous: Record<string, string | undefined> = {};
  const setEnv = (key: string, value: string) => {
    previous[key] = process.env[key];
    process.env[key] = value;
  };

  beforeAll(async () => {
    // Set BEFORE the module compiles: ConfigService snapshots the environment at
    // boot, and these three are what the gates read.
    setEnv('WHATSAPP_WEBHOOK_VERIFY_TOKEN', VERIFY_TOKEN);
    setEnv('WHATSAPP_APP_SECRET', APP_SECRET);
    setEnv('MESSAGING_RECIPIENT_ALLOWLIST', `${ALLOWED},  +91 900 000 0003 `);

    const { AppModule } = await import('../src/app.module');
    const { WhatsAppService } = await import('../src/integrations/whatsapp.service');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    // `rawBody: true`, exactly as bootstrap does — the signature is computed
    // over the unparsed bytes, and without this every correctly signed delivery
    // is refused for want of a body to check.
    app = mod.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    whatsapp = app.get(WhatsAppService);
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /* ------------------------------------------------------- 1. handshake */

  describe('the webhook handshake', () => {
    it('echoes the challenge when the token matches', async () => {
      const res = await request(server())
        .get('/integrations/whatsapp/webhook')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': '1158201444',
        })
        .expect(200);
      // Meta reads the body verbatim; anything but the bare challenge fails
      // subscription with no diagnostic beyond "The URL couldn't be validated".
      expect(res.text).toBe('1158201444');
    });

    it('refuses a token that is merely a prefix of the real one', async () => {
      await request(server())
        .get('/integrations/whatsapp/webhook')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN.slice(0, -1),
          'hub.challenge': 'x',
        })
        .expect(403);
    });

    it('refuses a mode that is not subscribe', async () => {
      await request(server())
        .get('/integrations/whatsapp/webhook')
        .query({ 'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'x' })
        .expect(403);
    });

    it('does not accept the Lead Ads token on the WhatsApp webhook', async () => {
      // The two tokens are deliberately different: one accepted for both would
      // let either Meta app authenticate as the other.
      const leadAds = process.env.META_WEBHOOK_VERIFY_TOKEN;
      if (!leadAds || leadAds === VERIFY_TOKEN) return; // nothing to distinguish
      await request(server())
        .get('/integrations/whatsapp/webhook')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': leadAds, 'hub.challenge': 'x' })
        .expect(403);
    });
  });

  /* ------------------------------------------------------- 2. signature */

  describe('the signature gate', () => {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { messages: [] } }] }],
    });
    const sign = (secret: string) =>
      `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

    it('accepts a correctly signed delivery', async () => {
      await request(server())
        .post('/integrations/whatsapp/webhook')
        .set('X-Hub-Signature-256', sign(APP_SECRET))
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(200);
    });

    it('refuses a body signed with the wrong secret', async () => {
      await request(server())
        .post('/integrations/whatsapp/webhook')
        .set('X-Hub-Signature-256', sign('not-the-secret'))
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(403);
    });

    it('refuses a delivery with no signature at all', async () => {
      await request(server())
        .post('/integrations/whatsapp/webhook')
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(403);
    });

    it('refuses a signature over a different body', async () => {
      // The whole point of signing the RAW body: a valid signature for one
      // payload must not admit another.
      await request(server())
        .post('/integrations/whatsapp/webhook')
        .set('X-Hub-Signature-256', sign(APP_SECRET))
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }))
        .expect(403);
    });

    it('fails CLOSED in production when no app secret is configured', () => {
      // The branch that actually matters, and the one nothing covered. In
      // development an unsigned request is accepted so a curl can drive the
      // webhook; in production that would be an open write endpoint.
      const secret = process.env.WHATSAPP_APP_SECRET;
      const env = process.env.NODE_ENV;
      try {
        delete process.env.WHATSAPP_APP_SECRET;
        (process.env as Record<string, string>).NODE_ENV = 'production';
        expect(whatsapp.verifySignature(Buffer.from(body), undefined)).toBe(false);
        expect(whatsapp.verifySignature(Buffer.from(body), sign(APP_SECRET))).toBe(false);
      } finally {
        if (secret === undefined) delete process.env.WHATSAPP_APP_SECRET;
        else process.env.WHATSAPP_APP_SECRET = secret;
        if (env === undefined) delete process.env.NODE_ENV;
        else (process.env as Record<string, string>).NODE_ENV = env;
      }
    });
  });

  /* ------------------------------------------------------- 3. allowlist */

  describe('the outbound allowlist', () => {
    /*
     * The door every WhatsApp send passes through — queue, delivery job and
     * retry alike — resolved from the container rather than constructed by
     * hand, so this exercises the wiring and not just the function.
     */
    it('refuses a recipient that is not on the list, and says why', async () => {
      const res = await whatsapp.sendText('org_eclat', NOT_ALLOWED, 'hello');
      expect(res.delivered).toBe(false);
      expect(res.dryRun).toBe(true);
      expect(res.reason).toMatch(/configured test recipients/i);
    });

    it('never leaks the refused number in full', async () => {
      const res = await whatsapp.sendText('org_eclat', NOT_ALLOWED, 'hello');
      expect(JSON.stringify(res.reason ?? '')).not.toContain(NOT_ALLOWED);
    });

    it('lets an allowlisted recipient past the door', async () => {
      // Past the ALLOWLIST — not delivered, because no credentials are
      // configured in a test run. What matters is which refusal comes back.
      const res = await whatsapp.sendText('org_eclat', ALLOWED, 'hello');
      expect(res.reason ?? '').not.toMatch(/configured test recipients/i);
    });

    it('normalises the list, so spacing and a leading + do not lock someone out', async () => {
      // "  +91 900 000 0003 " in the configured list must match "919000000003".
      const res = await whatsapp.sendText('org_eclat', '919000000003', 'hello');
      expect(res.reason ?? '').not.toMatch(/configured test recipients/i);
    });

    it('refuses everyone when the list parses to nothing', async () => {
      // A misconfigured allowlist reads as "nobody", never "everybody" — the
      // failure mode of the opposite choice is messaging real customers from
      // staging.
      const raw = process.env.MESSAGING_RECIPIENT_ALLOWLIST;
      try {
        process.env.MESSAGING_RECIPIENT_ALLOWLIST = ',,,';
        const res = await whatsapp.sendText('org_eclat', ALLOWED, 'hello');
        expect(res.reason).toMatch(/configured test recipients/i);
      } finally {
        if (raw === undefined) delete process.env.MESSAGING_RECIPIENT_ALLOWLIST;
        else process.env.MESSAGING_RECIPIENT_ALLOWLIST = raw;
      }
    });
  });
});
