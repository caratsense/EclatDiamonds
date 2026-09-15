#!/usr/bin/env node
/**
 * Five WhatsApp threads for the demo tenant, so the inbox can be worked on
 * locally.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `/conversations` fills from inbound webhooks. On a laptop no webhook ever
 * arrives, so the three-pane inbox, the message bubbles, the delivery receipts
 * and the intent drawer are all rendered against nothing — and a screen that is
 * empty for a structural reason cannot be reviewed, demonstrated or regression-
 * checked by looking at it.
 *
 * ── LOCAL ONLY, and it checks ───────────────────────────────────────────────
 *
 * This writes customers, enquiries and messages. It refuses any database that
 * is not on this machine, and refuses to run under NODE_ENV=production. Those
 * two checks are the whole safety story, and they are deliberately cheap enough
 * that nobody is tempted to skip them.
 *
 * ── Everything here is LABELLED as demo ─────────────────────────────────────
 *
 * Every row carries an id or provider reference beginning `demo`, and every
 * WhatsApp id is `wamid.DEMO…`. That is not decoration: it is how a person
 * looking at a database, or a later script cleaning one up, can tell seeded
 * theatre from a real customer's real message. Phone numbers are in the
 * documentation range and reach nobody.
 *
 * ── The intent scores are PRODUCED, not typed in ────────────────────────────
 *
 * No score is written by this file. Each customer's messages are worded so the
 * tenant's qualification rules land the thread in a different band, and then
 * the running backend assesses every thread through the same endpoint the
 * intent panel's refresh button calls. What the panel shows is therefore what
 * the engine concluded from the messages on screen — five situations, five
 * outcomes:
 *
 *   priya   ready to buy this week, ad lead, assistant handling   → Ready to talk
 *   vikram  bridal customisation, chasing charges, with a person  → Ready to talk
 *   ananya  moving an appointment, asks about a piece             → Interested
 *   rohan   browsing, comparing with another shop                 → Early
 *   neha    asked us to stop messaging her                        → Do not pursue
 *
 * If the backend is not running, the threads are still written and the script
 * says so; open a thread and press refresh in the intent panel to score it.
 *
 * ── Idempotent ──────────────────────────────────────────────────────────────
 *
 * Threads key on (organisationId, channel, externalThreadId) and messages on
 * (organisationId, externalId) — the same uniqueness the real webhook path
 * relies on. Running it twice updates in place.
 *
 * Usage:  npm run seed:local        (from backend/)
 */
import { PrismaClient } from '@prisma/client';

/* ------------------------------------------------------------------ guards */

const url = process.env.DATABASE_URL ?? '';
if (!url) {
  console.error('DATABASE_URL is not set. Run this from backend/ with a local .env.');
  process.exit(2);
}
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo conversations with NODE_ENV=production.');
  process.exit(2);
}
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
})();
if (!['localhost', '127.0.0.1', '::1', ''].includes(host)) {
  console.error(
    `Refusing to seed demo conversations into a database on "${host}". ` +
      'This script is for a local machine only — it writes customers, enquiries and messages.',
  );
  process.exit(2);
}

const prisma = new PrismaClient();

/* ------------------------------------------------------------------ helpers */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `n` hours before the moment the script started, so a run is self-consistent. */
const START = Date.now();
const ago = (hours) => new Date(START - hours * HOUR);
const tomorrow = () => {
  const d = new Date(START + DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

/* ------------------------------------------------------------------- threads */

/**
 * Five threads, chosen to cover different situations AND different outcomes
 * rather than five variations of the same happy path: the assistant handling a
 * ready buyer, a person working a customisation, nobody having picked up a
 * reschedule, a browser comparing prices, and a customer who asked us to stop.
 *
 * The qualification rules read only what the CUSTOMER wrote, and match whole
 * phrases. The comment on each customer message names the rule it trips, so a
 * change to the wording that moves a thread into another band is visible here
 * rather than discovered in the panel.
 *
 * `adId` is set only where a thread genuinely came from a click-to-WhatsApp ad.
 * An absent ad id must stay absent — the inbox renders "not provided by the
 * provider", and inventing one here would make that branch untestable.
 */
const THREADS = [
  {
    key: 'priya',
    party: { id: 'demo_pty_priya', name: 'Priya Sharma', phone: '919000000101' },
    storeId: 'surat-main',
    subject: 'Diamond solitaire enquiry',
    handling: 'ai',
    status: 'open',
    assignee: null,
    adId: 'demo_ad_solitaire_q3',
    interest: 'Solitaire ring, around 0.5 ct',
    messages: [
      // specific item: "do you have"
      { at: 26, dir: 'in', body: 'Hi, I saw your ad for solitaire rings. Do you have anything around 0.5 carat?' },
      { at: 25.8, dir: 'out', by: 'ai', body: 'Hello Priya — yes, there are 0.50 ct solitaires in 18K white and rose gold at the Surat showroom. What range are you considering?' },
      // budget: "budget" · purchase intent: "ready to buy" · soon: "this week"
      { at: 25.2, dir: 'in', body: 'My budget is around 1.5 lakh, and I am ready to buy this week.' },
      { at: 25.0, dir: 'out', by: 'ai', body: 'A 0.50 ct VS-clarity solitaire is ₹1,42,000 including making, with an IGI certificate.' },
      // visit: "visit"
      { at: 3.5, dir: 'in', body: 'Great. Can I visit the showroom on Saturday to see it?' },
    ],
    task: { title: 'Confirm Saturday appointment — solitaire viewing', priority: 'high' },
  },
  {
    key: 'vikram',
    party: { id: 'demo_pty_vikram', name: 'Vikram Mehta', phone: '919000000102' },
    storeId: 'mumbai-bandra',
    subject: 'Bridal set customisation',
    handling: 'human',
    status: 'open',
    assignee: 'karan.malhotra@caratsense.in',
    adId: null,
    interest: 'Bridal set, customised',
    messages: [
      // specific item: "this design"
      { at: 50, dir: 'in', body: 'We are looking at a bridal set for a December wedding. Can this design be made a little shorter?' },
      { at: 49.5, dir: 'out', by: 'agent', body: 'Yes, we can adjust the length and the drop. Would you like to come in so we can take measurements?' },
      // budget: "how much"
      { at: 30, dir: 'in', body: 'Please tell me how much the making charges would be for the change.' },
      { at: 29.2, dir: 'out', by: 'agent', body: 'I will put the revised quote together and send it across today.' },
      // visit: "visit" · soon: "next week"
      { at: 6, dir: 'in', body: 'Any update on the quote? We want to visit next week to finalise.' },
    ],
    task: { title: 'Send revised making-charge quote — bridal set', priority: 'urgent' },
  },
  {
    key: 'ananya',
    party: { id: 'demo_pty_ananya', name: 'Ananya Iyer', phone: '919000000103' },
    storeId: 'surat-main',
    subject: 'Appointment reschedule',
    handling: 'unassigned',
    status: 'open',
    assignee: null,
    adId: null,
    interest: 'Rose gold pendant',
    messages: [
      // visit: "appointment" · soon: "tomorrow"
      { at: 3, dir: 'in', body: 'Hi, I have an appointment tomorrow at 4pm. Could we move it to Friday?' },
      // specific item: "is this available"
      { at: 2.5, dir: 'in', body: 'Also, is this available in rose gold? It is the pendant from your Instagram post.' },
    ],
    task: { title: 'Confirm the moved appointment with Ananya', priority: 'normal' },
  },
  {
    key: 'rohan',
    party: { id: 'demo_pty_rohan', name: 'Rohan Kapoor', phone: '919000000104' },
    storeId: 'ahmedabad-cg',
    subject: 'Lab-grown bracelet, comparing',
    handling: 'ai',
    status: 'open',
    assignee: null,
    adId: 'demo_ad_tennis_bracelet',
    interest: 'Lab-grown tennis bracelet',
    messages: [
      // specific item: "do you have"
      { at: 20, dir: 'in', body: 'Hi, just looking for now. Do you have lab-grown tennis bracelets?' },
      { at: 19.8, dir: 'out', by: 'ai', body: 'Yes — lab-grown tennis bracelets from 2 ct upwards are in the Ahmedabad store.' },
      // comparison: "other shop"
      { at: 19, dir: 'in', body: 'OK. The other shop near me seems cheaper, I will think about it.' },
    ],
    task: null,
  },
  {
    key: 'neha',
    party: { id: 'demo_pty_neha', name: 'Neha Joshi', phone: '919000000105' },
    storeId: 'mumbai-bandra',
    subject: 'Asked to stop messages',
    handling: 'human',
    status: 'open',
    assignee: null,
    adId: null,
    interest: 'Opt-out request',
    messages: [
      { at: 30, dir: 'out', by: 'agent', body: 'Hello Neha, the new collection preview is open at our Bandra store this weekend.' },
      // complaint: "not happy"
      { at: 29, dir: 'in', body: 'Who gave you my number? I am not happy getting these messages.' },
      // not interested: "remove my number"
      { at: 28.5, dir: 'in', body: 'Please remove my number.' },
    ],
    task: { title: 'Record Neha’s opt-out and stop outreach', priority: 'urgent' },
  },
];

/* ---------------------------------------------------------------------- run */

async function main() {
  const org = await prisma.organisation.findFirst({ where: { slug: 'eclat' } });
  if (!org) {
    console.error('The demo tenant is missing. Run `npm run db:seed` first.');
    process.exit(2);
  }
  const organisationId = org.id;

  const users = await prisma.user.findMany({
    where: { organisationId },
    select: { id: true, email: true },
  });
  const userByEmail = new Map(users.map((u) => [u.email, u.id]));
  const agentId = userByEmail.get('head.office@caratsense.in') ?? null;

  const stores = await prisma.store.findMany({
    where: { organisationId, isAggregate: false },
    select: { id: true },
  });
  const storeIds = new Set(stores.map((s) => s.id));

  let threads = 0;
  let messages = 0;

  for (const t of THREADS) {
    // Fall back to any real branch rather than writing a store id that does not
    // exist in this database — a foreign key error halfway through a seed is a
    // worse outcome than a thread landing at a different counter.
    const storeId = storeIds.has(t.storeId) ? t.storeId : (stores[0]?.id ?? null);
    if (!storeId) {
      console.error('No branch exists in this database. Run `npm run db:seed` first.');
      process.exit(2);
    }

    /* ---------------------------------------------------------- the customer */
    const party = await prisma.party.upsert({
      where: { id: t.party.id },
      update: { name: t.party.name, phone: t.party.phone, whatsapp: t.party.phone, storeId },
      create: {
        id: t.party.id,
        organisationId,
        storeId,
        name: t.party.name,
        types: ['customer'],
        phone: t.party.phone,
        whatsapp: t.party.phone,
        city: 'Demo',
      },
    });

    // The contact point is what makes an inbound number resolve to THIS
    // customer, exactly as the live identity path would have written it.
    await prisma.contactPoint.upsert({
      where: {
        organisationId_kind_valueNormalized: {
          organisationId,
          kind: 'phone',
          valueNormalized: t.party.phone,
        },
      },
      update: { partyId: party.id },
      create: {
        organisationId,
        partyId: party.id,
        kind: 'phone',
        value: `+${t.party.phone}`,
        valueNormalized: t.party.phone,
        source: 'demo_seed',
      },
    });

    /* ------------------------------------------------------------- the lead */
    const originKey = `demo_seed:${t.key}`;
    const existingLead = await prisma.lead.findFirst({
      where: { organisationId, originKey },
      select: { id: true },
    });
    const lead = existingLead
      ? await prisma.lead.update({
          where: { id: existingLead.id },
          data: {
            interest: t.interest,
            outcome: t.status === 'closed' ? 'lost' : 'open',
            lastActivity: ago(t.messages[t.messages.length - 1].at),
          },
        })
      : await prisma.lead.create({
          data: {
            organisationId,
            ref: `LD-DEMO-${t.key.toUpperCase()}`,
            storeId,
            partyId: party.id,
            customerName: t.party.name,
            phone: t.party.phone,
            source: t.adId ? 'meta_ads' : 'whatsapp',
            interest: t.interest,
            originKey,
            outcome: t.status === 'closed' ? 'lost' : 'open',
            lastActivity: ago(t.messages[t.messages.length - 1].at),
            ownerId: t.assignee ? (userByEmail.get(t.assignee) ?? null) : null,
          },
        });

    /* ------------------------------------------------------------ the thread */
    const externalThreadId = `demo-thread-${t.key}`;
    const first = t.messages[0];
    const last = t.messages[t.messages.length - 1];
    const lastInbound = [...t.messages].reverse().find((m) => m.dir === 'in') ?? last;

    const conversationData = {
      storeId,
      partyId: party.id,
      status: t.status,
      handling: t.handling,
      assignedUserId: t.assignee ? (userByEmail.get(t.assignee) ?? null) : null,
      subject: t.subject,
      lastMessageAt: ago(last.at),
      lastInboundAt: ago(lastInbound.at),
      // Only where the click actually carried one. A null ad id renders as
      // "not provided", which is a state worth being able to look at.
      sourceAdId: t.adId,
    };

    const conversation = await prisma.conversation.upsert({
      where: {
        organisationId_channel_externalThreadId: {
          organisationId,
          channel: 'whatsapp',
          externalThreadId,
        },
      },
      update: conversationData,
      create: {
        organisationId,
        channel: 'whatsapp',
        externalThreadId,
        createdAt: ago(first.at),
        ...conversationData,
      },
    });
    threads += 1;

    /* ---------------------------------------------------------- the messages */
    // Only this script's own lines are removed — a reply someone typed into the
    // thread locally has no DEMO external id and is kept.
    await prisma.message.deleteMany({
      where: {
        organisationId,
        conversationId: conversation.id,
        externalId: {
          startsWith: `wamid.DEMO.${t.key}.`,
          notIn: t.messages.map((_, i) => `wamid.DEMO.${t.key}.${i}`),
        },
      },
    });
    for (const [i, m] of t.messages.entries()) {
      const externalId = `wamid.DEMO.${t.key}.${i}`;
      const sentAt = ago(m.at);
      const inbound = m.dir === 'in';
      const data = {
        conversationId: conversation.id,
        direction: inbound ? 'inbound' : 'outbound',
        authorType: inbound ? 'customer' : m.by === 'ai' ? 'ai' : 'agent',
        authorUserId: inbound || m.by === 'ai' ? null : agentId,
        body: m.body,
        // What the provider last told us. An inbound message is 'received';
        // an outbound one carries the receipt it actually got — 'read' for the
        // older ones, 'delivered' for the most recent, which is what a real
        // thread looks like a few minutes after a reply goes out.
        status: inbound ? 'received' : m.at > 12 ? 'read' : 'delivered',
        sentAt,
      };
      await prisma.message.upsert({
        where: { organisationId_externalId: { organisationId, externalId } },
        update: data,
        create: { organisationId, externalId, ...data },
      });
      messages += 1;
    }

    /* --------------------------------------------------------- the intent row */
    // Earlier versions of this script wrote hand-typed scores under the
    // provider 'demo_seed'. Remove them so the panel only ever shows what the
    // engine concluded (see assessThroughBackend below).
    await prisma.leadQualification.deleteMany({
      where: { organisationId, conversationId: conversation.id, provider: 'demo_seed' },
    });

    /* ----------------------------------------------------------- the follow-up */
    if (t.task) {
      const title = `${t.task.title} (demo)`;
      const existingTask = await prisma.task.findFirst({
        where: { organisationId, leadId: lead.id, title },
        select: { id: true },
      });
      const taskData = {
        storeId,
        partyId: party.id,
        leadId: lead.id,
        priority: t.task.priority,
        status: 'open',
        dueDate: tomorrow(),
        assigneeId: t.assignee ? (userByEmail.get(t.assignee) ?? null) : null,
        detail: 'Seeded by scripts/seed-conversations.mjs for local review.',
      };
      if (existingTask) {
        await prisma.task.update({ where: { id: existingTask.id }, data: taskData });
      } else {
        await prisma.task.create({ data: { organisationId, title, ...taskData } });
      }
    }
  }

  console.log(`Seeded ${threads} WhatsApp threads and ${messages} messages into "${org.slug}".`);
  await assessThroughBackend(organisationId);
  console.log('Open http://localhost:3000/conversations to work them.');
}

/**
 * Score every seeded thread with the REAL qualification engine, through the
 * running backend — the same request the intent panel's refresh button sends.
 *
 * The rules are switched on for the demo tenant first if they are off, because
 * an engine that is switched off answers "unavailable" for all five threads and
 * the panel would show nothing to compare. That is a setting on the local demo
 * tenant only; the guards at the top of this file are what keep it local.
 */
async function assessThroughBackend(organisationId) {
  const base = (process.env.SEED_API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`).replace(/\/+$/, '');
  const call = async (path, token, body) => {
    const res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    return res.json();
  };

  let token;
  try {
    ({ token } = await call('/auth/login', null, { email: 'head.office@caratsense.in', password: 'password123' }));
  } catch (error) {
    console.log(`Scores not produced — the backend at ${base} is not reachable (${error.message}).`);
    console.log('Start it, then open each thread and press refresh in the intent panel.');
    return;
  }

  const { policy } = await call('/crm/qualification/policy', token);
  if (!policy.enabled) {
    await call('/crm/qualification/policy', token, { enabled: true });
    console.log('Switched lead qualification on for the demo tenant (it was off).');
  }

  for (const t of THREADS) {
    const conversation = await prisma.conversation.findUnique({
      where: {
        organisationId_channel_externalThreadId: {
          organisationId,
          channel: 'whatsapp',
          externalThreadId: `demo-thread-${t.key}`,
        },
      },
      select: { id: true },
    });
    const q = await call(`/crm/qualification/conversations/${conversation.id}`, token, {});
    const outcome = q.available
      ? `${q.score} · ${q.bandLabel} · confidence ${Math.round((q.confidence ?? 0) * 100)}% · ${q.method}`
      : `unavailable — ${q.unavailableReason}`;
    console.log(`  ${t.party.name.padEnd(14)} ${outcome}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
