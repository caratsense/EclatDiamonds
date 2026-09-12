import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import type { PrismaService } from '../src/prisma/prisma.service';
import { OutboundHttp } from '../src/integrations/adapters/outbound-http';
import { evaluateDeliveryPolicy } from '../src/omnichannel/omnichannel-policy';

/**
 * The outbound adapters, and what each of them is honest about.
 *
 * FIXTURE-TESTED, AND THAT IS THE POINT OF THE FILE. No Instagram account, no
 * telephony network, no SMTP server and no AI vendor is contacted anywhere in
 * it. Each adapter's request is built in full and driven against a STUBBED
 * transport that records exactly what would have gone on the wire — so what is
 * proven is the request, the auth header, the error handling and the reported
 * state. What is NOT proven, and is never claimed, is that any provider would
 * accept it. Every adapter reports `verified: false` until one does.
 *
 * What each group defends:
 *
 *  1. THREE STATES, NOT TWO. `dry_run` is neither `live` nor `unavailable`, and
 *     collapsing it either way is a lie: into live it reports deliveries that
 *     never happened, into unavailable it hides a finished code path and makes
 *     the remaining work look bigger than it is.
 *
 *  2. AN UNAVAILABLE CHANNEL IS NOT AN ERROR. "Instagram is not connected" is an
 *     outcome the outbox records against a message. Throwing would make it look
 *     like the process was broken.
 *
 *  3. THE POLICY ASKS, RATHER THAN ASSUMING. `channel !== 'whatsapp'` could not
 *     say why a channel was unavailable and gave the same answer to a tenant who
 *     had connected Instagram and one who had not.
 *
 *  4. THE AI HAS ONE ANSWER. Two classes read the same four variables with
 *     different rules and disagreed: a bare key made extraction report itself
 *     available while drafting silently did nothing, and naming OpenAI did the
 *     reverse. Either way a screen could say "AI is connected" while half of
 *     what it enables did nothing.
 *
 *  5. NOTHING LEAKS. No token, no phone-number id, no API key appears in the
 *     report, and a provider error that echoes a credential is redacted before
 *     it is stored.
 */

process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 31).toString('base64');
process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = '1';
process.env.META_GRAPH_API_VERSION = 'v21.0';

const PASSWORD = 'password123';

const A = {
  org: 'org_adapt_a',
  slug: 'adapt-a',
  store: 'store_adapt_a',
  ho: 'ho.adapt@adapt-a.local',
  rep: 'rep.adapt@adapt-a.local',
};

const IG_ACCOUNT = '17841400000000001';
const IG_TOKEN = 'ig-page-token-fixture';
const DIAL_URL = 'https://dialler.example/v1/calls';
const DIAL_KEY = 'dial-key-fixture';

/** Records what would have gone on the wire, and answers what a test tells it. */
class StubTransport {
  calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  next: { status: number; ok: boolean; body: unknown } | Error = {
    status: 200,
    ok: true,
    body: { message_id: 'ig.fixture.1' },
  };

  async postJson(url: string, headers: Record<string, string>, body: unknown) {
    this.calls.push({ url, headers, body });
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }

  last() {
    return this.calls[this.calls.length - 1];
  }

  reset() {
    this.calls = [];
    this.next = { status: 200, ok: true, body: { message_id: 'ig.fixture.1' } };
  }
}

async function teardown(prisma: PrismaService) {
  // The auto-call test writes SLA settings, and Organisation's FK is RESTRICT.
  await prisma.conversationResponseSla.deleteMany({ where: { organisationId: A.org } });
  await prisma.conversationSlaSettings.deleteMany({ where: { organisationId: A.org } });
  await prisma.integrationCredential.deleteMany({ where: { organisationId: A.org } });
  await prisma.integrationAsset.deleteMany({ where: { organisationId: A.org } });
  await prisma.integration.deleteMany({ where: { organisationId: A.org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: A.org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: A.org } } });
  await prisma.user.deleteMany({ where: { organisationId: A.org } });
  await prisma.store.deleteMany({ where: { organisationId: A.org } });
  await prisma.organisation.deleteMany({ where: { id: A.org } });
}

describe('Outbound channel adapters (e2e, fixture-tested)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const transport = new StubTransport();

  let instagram: import('../src/integrations/adapters/instagram.adapter').InstagramAdapter;
  let voice: import('../src/integrations/adapters/telephony-outbound.adapter').TelephonyOutboundAdapter;
  let adapters: import('../src/integrations/adapters/channel-adapters.service').ChannelAdaptersService;
  let ai: import('../src/crm/ai/ai-provider-config').AiProviderConfig;

  let hoT: string;
  let repT: string;

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  /** Seal a secret the way the registry would, so the adapter can read it back. */
  async function saveCredential(integrationId: string, kind: string, value: string) {
    const { CredentialCrypto } = await import(
      '../src/integration/framework/credential-crypto'
    );
    const crypto = app.get(CredentialCrypto);
    const sealed = crypto.encrypt(value, {
      organisationId: A.org,
      integrationId,
      kind,
    });
    await prisma.integrationCredential.upsert({
      where: { integrationId_kind: { integrationId, kind } },
      create: { organisationId: A.org, integrationId, kind, ...sealed },
      update: sealed,
    });
  }

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService: P } = await import('../src/prisma/prisma.service');
    const { InstagramAdapter } = await import('../src/integrations/adapters/instagram.adapter');
    const { TelephonyOutboundAdapter } = await import(
      '../src/integrations/adapters/telephony-outbound.adapter'
    );
    const { ChannelAdaptersService } = await import(
      '../src/integrations/adapters/channel-adapters.service'
    );
    const { AiProviderConfig } = await import('../src/crm/ai/ai-provider-config');

    const mod = await Test.createTestingModule({ imports: [AppModule] })
      // THE SEAM. Every adapter reaches the internet through this one service, so
      // replacing it is what makes a full request assertable without a provider.
      .overrideProvider(OutboundHttp)
      .useValue(transport)
      .compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(P);
    instagram = app.get(InstagramAdapter);
    voice = app.get(TelephonyOutboundAdapter);
    adapters = app.get(ChannelAdaptersService);
    ai = app.get(AiProviderConfig);
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);
    await prisma.organisation.create({
      data: { id: A.org, name: 'Adapt A', slug: A.slug, industryPackCode: 'jewellery' },
    });
    await prisma.store.create({
      data: {
        id: A.store,
        name: 'Adapt main',
        city: 'Mumbai',
        organisationId: A.org,
        timezone: 'Asia/Kolkata',
      },
    });
    for (const [id, email, role] of [
      ['u_adapt_ho', A.ho, 'head_office'],
      ['u_adapt_rep', A.rep, 'salesperson'],
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
          organisationId: A.org,
          userStores: { create: { storeId: A.store, isPrimary: true } },
        },
      });
    }

    const login = async (email: string) =>
      (
        await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201)
      ).body.token;
    hoT = await login(A.ho);
    repT = await login(A.rep);
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  beforeEach(() => transport.reset());

  /* ================================================= 1. nothing connected */

  describe('with nothing connected', () => {
    it('says Instagram needs an app review, not a setting', async () => {
      const state = await instagram.deliverability(A.org);
      expect(state.state).toBe('unavailable');
      expect(state.code).toBe('no_integration');
      // The reason names the actual obstacle. "Not configured" would send
      // somebody looking for a form that does not exist.
      expect(state.reason).toContain('app-review process rather than a setting');
      expect(state.verified).toBe(false);
    });

    it('says no telephony provider is connected', async () => {
      const state = await voice.deliverability(A.org);
      expect(state.state).toBe('unavailable');
      expect(state.code).toBe('no_integration');
      expect(state.reason).toContain('no call can be placed');
    });

    it('calls email a DRY RUN rather than unavailable, because the path is finished', async () => {
      const state = await adapters.deliverability(A.org, 'email');
      // Three states, not two. The code runs and logs what it would have sent;
      // calling that unavailable hides a complete path.
      expect(state.state).toBe('dry_run');
      expect(state.reason).toContain('written to the log rather than sent');
    });

    it('calls WhatsApp a dry run too, for the same reason', async () => {
      const state = await adapters.deliverability(A.org, 'whatsapp');
      expect(state.state).toBe('dry_run');
      // The resolver's own sentence, which knows which of several problems it is.
      expect(state.reason).toContain('No WhatsApp number is connected');
    });

    it('refuses to send on an unavailable channel WITHOUT throwing', async () => {
      const result = await instagram.send(A.org, { to: 'ig-user-1', body: 'Hello' });
      // An unavailable channel is an outcome the outbox records against a
      // message, not an exception that looks like a broken process.
      expect(result.delivered).toBe(false);
      expect(result.dryRun).toBe(true);
      expect(result.reason).toContain('not connected');
      expect(transport.calls).toHaveLength(0);
    });

    it('answers for a channel that has no adapter at all', async () => {
      const state = await adapters.deliverability(A.org, 'telegram');
      expect(state.state).toBe('unavailable');
      expect(state.reason).toContain('no outbound adapter');

      const sent = await adapters.send(A.org, 'telegram', { to: 'x', body: 'y' });
      expect(sent.delivered).toBe(false);
    });
  });

  /* ==================================================== 2. Instagram */

  describe('Instagram, connected', () => {
    beforeAll(async () => {
      const integration = await prisma.integration.create({
        data: {
          organisationId: A.org,
          providerCode: 'instagram',
          name: 'Shop IG',
          status: 'connected',
        },
      });
      await prisma.integrationAsset.create({
        data: {
          organisationId: A.org,
          integrationId: integration.id,
          kind: 'instagram_account',
          externalId: IG_ACCOUNT,
          isActive: true,
        },
      });
      await saveCredential(integration.id, 'access_token', IG_TOKEN);
    });

    it('reports itself ready but NOT verified', async () => {
      const state = await instagram.deliverability(A.org);
      expect(state.state).toBe('live');
      expect(state.code).toBe('ready');
      // A saved token and a registered account are what somebody typed. Only a
      // successful provider response is evidence, and there has never been one.
      expect(state.verified).toBe(false);
    });

    it('builds the request Meta documents, with the token in a header', async () => {
      const result = await instagram.send(A.org, {
        to: 'ig-user-1',
        body: '  Thanks for your message  ',
      });
      expect(result.delivered).toBe(true);
      expect(result.externalId).toBe('ig.fixture.1');

      const call = transport.last();
      expect(call.url).toBe(`https://graph.facebook.com/v21.0/${IG_ACCOUNT}/messages`);
      // A header, never a query parameter: a token in a URL is a token in every
      // proxy log between here and Meta.
      expect(call.headers.authorization).toBe(`Bearer ${IG_TOKEN}`);
      expect(call.body).toEqual({
        recipient: { id: 'ig-user-1' },
        message: { text: 'Thanks for your message' },
        messaging_type: 'RESPONSE',
      });
    });

    it('does not call itself delivered when the provider returns no message id', async () => {
      transport.next = { status: 200, ok: true, body: { ok: true } };
      const result = await instagram.send(A.org, { to: 'ig-user-1', body: 'Hello' });
      // A 200 with no id leaves a message nobody can trace or reconcile a
      // receipt against, so it is not a delivery.
      expect(result.delivered).toBe(false);
      expect(result.reason).toContain('no message id');
    });

    it('redacts a provider error that echoes the credential', async () => {
      transport.next = {
        status: 400,
        ok: false,
        body: {
          error: {
            message: `Invalid OAuth access token: Bearer ${IG_TOKEN} for https://graph.facebook.com/v21.0/x`,
          },
        },
      };
      const result = await instagram.send(A.org, { to: 'ig-user-1', body: 'Hello' });
      expect(result.delivered).toBe(false);
      // The error is stored and shown, so it must not carry the token or the URL.
      expect(result.error).toBeTruthy();
      expect(result.error).not.toContain(IG_TOKEN);
      expect(result.error).toContain('[redacted]');
      expect(result.error).not.toContain('graph.facebook.com');
    });

    it('reports a transport failure as itself, not as a refusal', async () => {
      const { OutboundHttpError } = await import(
        '../src/integrations/adapters/outbound-http'
      );
      transport.next = new OutboundHttpError('The request to the provider timed out.');
      const result = await instagram.send(A.org, { to: 'ig-user-1', body: 'Hello' });
      expect(result.delivered).toBe(false);
      expect(result.error).toContain('timed out');
    });

    it('needs text', async () => {
      const result = await instagram.send(A.org, { to: 'ig-user-1' });
      expect(result.delivered).toBe(false);
      expect(result.reason).toContain('needs text');
      expect(transport.calls).toHaveLength(0);
    });

    it('will not call Graph without an explicit API version', async () => {
      const saved = process.env.META_GRAPH_API_VERSION;
      process.env.META_GRAPH_API_VERSION = '';
      try {
        const state = await instagram.deliverability(A.org);
        // Never defaulted: the request shape changes between versions, and
        // guessing one produces failures nobody can explain.
        expect(state.state).toBe('unavailable');
        expect(state.reason).toContain('never guessed');
      } finally {
        process.env.META_GRAPH_API_VERSION = saved;
      }
    });
  });

  /* ==================================================== 3. telephony out */

  describe('placing a call', () => {
    let integrationId = '';

    beforeAll(async () => {
      const integration = await prisma.integration.create({
        data: {
          organisationId: A.org,
          providerCode: 'telephony',
          name: 'Shop dialler',
          status: 'connected',
          capabilities: { inboundNotification: true },
        },
      });
      integrationId = integration.id;
    });

    it('separates "receives calls" from "can place them"', async () => {
      const state = await voice.deliverability(A.org);
      expect(state.state).toBe('unavailable');
      expect(state.code).toBe('capability_missing');
      // Outbound dialling is a separate product with most Indian providers, and
      // claiming it would make the SLA report calls it never made.
      expect(state.reason).toContain('separate product');
      expect(state.capabilities).toEqual({ inboundNotification: true, outboundCall: false });
    });

    it('asks for a dialling endpoint rather than inventing one', async () => {
      await prisma.integration.update({
        where: { id: integrationId },
        data: { capabilities: { inboundNotification: true, outboundCall: true } },
      });
      const state = await voice.deliverability(A.org);
      expect(state.code).toBe('not_configured');
      // There is no such thing as "the" telephony API, and the reason says so.
      expect(state.reason).toContain('no single telephony API to guess at');
    });

    it('refuses a plain-http dialling endpoint', async () => {
      await prisma.integration.update({
        where: { id: integrationId },
        data: { config: { outboundCallUrl: 'http://dialler.example/v1/calls' } },
      });
      const state = await voice.deliverability(A.org);
      expect(state.code).toBe('not_configured');
      expect(state.reason).toContain('must be https');
    });

    it('needs an API key before it will authenticate a dial request', async () => {
      await prisma.integration.update({
        where: { id: integrationId },
        data: { config: { outboundCallUrl: DIAL_URL } },
      });
      const state = await voice.deliverability(A.org);
      expect(state.code).toBe('no_credential');
    });

    it('posts the tenant’s own field names, because theirs are what their provider reads', async () => {
      await saveCredential(integrationId, 'api_key', DIAL_KEY);
      await prisma.integration.update({
        where: { id: integrationId },
        data: {
          config: {
            outboundCallUrl: DIAL_URL,
            outboundCallMap: { to: 'customer_number', from: 'agent_number' },
          },
        },
      });
      transport.next = { status: 200, ok: true, body: { Call: { Sid: 'call-fixture-1' } } };

      const result = await voice.send(A.org, {
        to: '919812300011',
        extra: { from: '912200000000', flow_id: 'after-hours' },
      });
      expect(result.delivered).toBe(true);
      expect(result.externalId).toBe('call-fixture-1');
      // Said plainly: accepting a dial request is not a conversation.
      expect(result.reason).toContain('Whether the call connects is reported later');

      const call = transport.last();
      expect(call.url).toBe(DIAL_URL);
      expect(call.headers.authorization).toBe(`Bearer ${DIAL_KEY}`);
      expect(call.body).toEqual({
        customer_number: '919812300011',
        agent_number: '912200000000',
        flow_id: 'after-hours',
      });
    });

    it('drops a passthrough field that is not a plain scalar', async () => {
      transport.next = { status: 200, ok: true, body: { sid: 'call-2' } };
      await voice.send(A.org, {
        to: '919812300011',
        extra: { nested: { a: 1 } as never, 'bad key': 'x', ok_field: 'y' },
      });
      const body = transport.last().body as Record<string, unknown>;
      // An object here would be a provider payload nobody validated.
      expect(body.nested).toBeUndefined();
      expect(body['bad key']).toBeUndefined();
      expect(body.ok_field).toBe('y');
    });

    it('reports a refusal as a refusal', async () => {
      transport.next = { status: 402, ok: false, body: { message: 'Insufficient balance' } };
      const result = await voice.send(A.org, { to: '919812300011' });
      expect(result.delivered).toBe(false);
      expect(result.reason).toContain('refused the call request');
      expect(result.error).toContain('Insufficient balance');
    });

    it('is what the five-minute SLA now asks before it claims it can call', async () => {
      // The SLA used to read the Integration row itself, checking the connection
      // and the capability flag but neither the endpoint nor the key — so it
      // could report automatic calling as ready and then skip every breach.
      await request(server())
        .put('/crm/sla/settings')
        .set(auth(hoT))
        .send({ firstResponseMinutes: 5, autoCallOnBreach: true })
        .expect(200);

      const ready = await request(server()).get('/crm/sla/settings').set(auth(hoT)).expect(200);
      // Everything is configured now, so there is genuinely nothing blocking it.
      expect(ready.body.autoCallBlockedReason).toBeNull();

      // Take the key away and the SLA says so, in the adapter's words.
      await prisma.integrationCredential.deleteMany({
        where: { integrationId, kind: 'api_key' },
      });
      const blocked = await request(server()).get('/crm/sla/settings').set(auth(hoT)).expect(200);
      expect(blocked.body.autoCallBlockedReason).toContain('no API key saved');

      await saveCredential(integrationId, 'api_key', DIAL_KEY);
    });
  });

  /* ======================================================= 4. the policy */

  describe('the delivery policy asks instead of assuming', () => {
    const base = {
      purpose: 'service' as const,
      consent: 'granted' as const,
      hasApprovedTemplate: false,
      lastInboundAt: new Date(),
    };

    it('still fails closed when nothing tells it about the channel', () => {
      // A pure function with no information must give the most restrictive
      // answer it can rather than assume a transport exists.
      const decision = evaluateDeliveryPolicy({ ...base, channel: 'instagram' });
      expect(decision).toMatchObject({ allowed: false, code: 'channel_not_connected' });
    });

    it('uses the adapter’s own sentence when one is supplied', () => {
      const decision = evaluateDeliveryPolicy({
        ...base,
        channel: 'instagram',
        channelDeliverable: { deliverable: false, reason: 'Needs a reviewed Meta app.' },
      });
      expect(decision).toEqual({
        allowed: false,
        code: 'channel_not_connected',
        reason: 'Needs a reviewed Meta app.',
      });
    });

    it('lets a connected non-WhatsApp channel through', () => {
      const decision = evaluateDeliveryPolicy({
        ...base,
        channel: 'instagram',
        channelDeliverable: { deliverable: true, reason: 'Ready.' },
      });
      expect(decision).toEqual({ allowed: true, mode: 'free_text' });
    });

    it('does not impose WhatsApp’s 24-hour window on email', () => {
      const decision = evaluateDeliveryPolicy({
        ...base,
        channel: 'email',
        // Nobody has written in for a week. On WhatsApp that needs a template;
        // on email it is an ordinary message a tenant is entitled to send.
        lastInboundAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        channelDeliverable: { deliverable: true, reason: 'Ready.' },
      });
      expect(decision).toEqual({ allowed: true, mode: 'free_text' });
    });

    it('still enforces the window on WhatsApp', () => {
      const decision = evaluateDeliveryPolicy({
        ...base,
        channel: 'whatsapp',
        lastInboundAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        channelDeliverable: { deliverable: true, reason: 'Ready.' },
      });
      expect(decision).toMatchObject({ allowed: false, code: 'template_required' });
    });

    it('checks consent before it checks the channel’s window', () => {
      const decision = evaluateDeliveryPolicy({
        ...base,
        channel: 'email',
        purpose: 'marketing',
        consent: 'unknown',
        channelDeliverable: { deliverable: true, reason: 'Ready.' },
      });
      // A working transport does not make an unconsented marketing message
      // sendable. The tenant's rules outrank the provider's readiness.
      expect(decision).toMatchObject({ allowed: false, code: 'consent_required' });
    });
  });

  /* ========================================================== 5. the AI */

  describe('one answer about the AI', () => {
    const vars = ['CRM_AI_API_KEY', 'CRM_AI_PROVIDER', 'CRM_AI_MODEL'] as const;
    let saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      saved = Object.fromEntries(vars.map((v) => [v, process.env[v]]));
      for (const v of vars) delete process.env[v];
    });
    afterEach(() => {
      for (const v of vars) {
        if (saved[v] === undefined) delete process.env[v];
        else process.env[v] = saved[v]!;
      }
    });

    it('reports nothing configured when there is no key', () => {
      const state = ai.describe();
      expect(state.configured).toBe(false);
      expect(state.vendor).toBeNull();
      // Not silence: it says what happens instead, which is a real
      // qualification on the tenant's own phrase rules.
      expect(state.reason).toContain('keyword rules');
      expect(state.capabilities.extraction.enabled).toBe(false);
      expect(state.capabilities.drafting.enabled).toBe(false);
    });

    it('enables BOTH capabilities from a bare key, where they used to disagree', () => {
      process.env.CRM_AI_API_KEY = 'fixture-key';
      const state = ai.describe();
      // The old bug: extraction defaulted the vendor to Anthropic and reported
      // itself available, while drafting required an explicit vendor and
      // silently returned nothing on every message.
      expect(state.configured).toBe(true);
      expect(state.vendor).toBe('anthropic');
      expect(state.capabilities.extraction.enabled).toBe(true);
      expect(state.capabilities.drafting.enabled).toBe(true);
    });

    it('says plainly which capability a vendor does not support', () => {
      process.env.CRM_AI_API_KEY = 'fixture-key';
      process.env.CRM_AI_PROVIDER = 'openai';
      const state = ai.describe();
      expect(state.configured).toBe(true);
      // The other half of the same bug, in the other direction. Now it is
      // reported per capability instead of one of them lying.
      expect(state.capabilities.drafting.enabled).toBe(true);
      expect(state.capabilities.extraction.enabled).toBe(false);
      expect(state.capabilities.extraction.reason).toContain('only implemented against');
    });

    it('refuses a vendor nobody implemented rather than quietly using another', () => {
      process.env.CRM_AI_API_KEY = 'fixture-key';
      process.env.CRM_AI_PROVIDER = 'gemini';
      const state = ai.describe();
      expect(state.configured).toBe(false);
      // Sending their traffic to Anthropic because they typed "gemini" would be
      // worse than doing nothing.
      expect(state.reason).toContain('not implemented');
      expect(state.vendor).toBeNull();
    });

    it('never puts the key in anything that gets logged', () => {
      process.env.CRM_AI_API_KEY = 'fixture-key-secret';
      expect(ai.name).toBe('anthropic/claude-sonnet-5');
      expect(JSON.stringify(ai.describe())).not.toContain('fixture-key-secret');
    });
  });

  /* ====================================================== 6. the report */

  describe('the report', () => {
    it('lists every channel with its state and reason', async () => {
      const res = await request(server()).get('/adapters').set(auth(hoT)).expect(200);
      const byChannel = Object.fromEntries(
        res.body.channels.map((c: { channel: string }) => [c.channel, c]),
      );
      expect(Object.keys(byChannel).sort()).toEqual(['email', 'instagram', 'voice', 'whatsapp']);
      for (const channel of res.body.channels) {
        expect(channel.reason).toBeTruthy();
        expect(['live', 'dry_run', 'unavailable']).toContain(channel.state);
      }
    });

    it('keeps live and dry-run apart, because the work they imply is different', async () => {
      const res = await request(server()).get('/adapters').set(auth(hoT)).expect(200);
      // A dry run is a configuration task. Unavailable can be an app review or a
      // DLT registration, measured in weeks.
      expect(res.body.liveChannels).toContain('instagram');
      expect(res.body.dryRunChannels).toContain('whatsapp');
      expect(res.body.liveChannels).not.toContain('email');
    });

    it('states that nothing is provider-verified, rather than implying it is', async () => {
      const res = await request(server()).get('/adapters').set(auth(hoT)).expect(200);
      expect(res.body.verification.anyVerified).toBe(false);
      expect(res.body.verification.note).toContain('fixture-tested');
      expect(res.body.verification.note).toContain('None has yet had a successful');
    });

    it('carries no secret at all', async () => {
      const res = await request(server()).get('/adapters').set(auth(hoT)).expect(200);
      const body = JSON.stringify(res.body);
      for (const secret of [IG_TOKEN, DIAL_KEY, IG_ACCOUNT]) {
        expect(body).not.toContain(secret);
      }
    });

    it('is readable by a salesperson, who is the one promising the customer a reply', async () => {
      const res = await request(server()).get('/adapters').set(auth(repT)).expect(200);
      expect(res.body.channels.length).toBeGreaterThan(0);
    });

    it('answers for one channel on its own', async () => {
      const res = await request(server()).get('/adapters/instagram').set(auth(hoT)).expect(200);
      expect(res.body.channel).toBe('instagram');
      expect(res.body.state).toBe('live');
      expect(res.body.verified).toBe(false);
    });
  });

  /* ============================================== 7. the transport itself */

  describe('the transport', () => {
    it('refuses to carry a credential over plain http', async () => {
      const real = new OutboundHttp();
      await expect(real.postJson('http://example.test/x', {}, {})).rejects.toThrow(
        /non-https/i,
      );
    });

    it('redacts a bearer token, a URL and a long opaque run', () => {
      const dirty =
        'Invalid token Bearer abc.def.ghi at https://provider.example/v1/send ' +
        'A'.repeat(100);
      const clean = OutboundHttp.redact(dirty, 401);
      expect(clean).toContain('HTTP 401');
      expect(clean).toContain('[redacted]');
      expect(clean).toContain('[url]');
      expect(clean).toContain('[opaque]');
      expect(clean.length).toBeLessThanOrEqual(320);
    });

    it('falls back to a generic sentence when the provider says nothing useful', () => {
      expect(OutboundHttp.redact(null, 500)).toContain('HTTP 500');
      expect(OutboundHttp.redact('   ', null)).toBe('The provider refused it.');
    });

    it('finds a provider message wherever it is nested', () => {
      expect(OutboundHttp.providerMessage({ error: { message: 'nope' } })).toBe('nope');
      expect(OutboundHttp.providerMessage({ message: 'plain' })).toBe('plain');
      expect(OutboundHttp.providerMessage({ error: { description: 'desc' } })).toBe('desc');
    });
  });
});
