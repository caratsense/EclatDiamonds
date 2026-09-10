#!/usr/bin/env node
/**
 * Four WhatsApp threads for the demo tenant, so the inbox can be worked on
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
 * ── The intent records are SHAPED, not stuffed ──────────────────────────────
 *
 * Each qualification's signals quote the actual seeded message that fired them,
 * so the intent panel's "what moved the score" section shows real evidence
 * drawn from the thread you are looking at. One thread is deliberately left
 * UNASSESSED and one is deliberately unassessable, because those are two of the
 * three states that panel exists to distinguish and neither can be reviewed if
 * the seed only ever produces the happy one.
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
 * Four threads, chosen to cover the states the inbox distinguishes rather than
 * four variations of the same happy path: one with the assistant handling it,
 * one assigned to a person, one nobody has picked up, and one closed.
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
      { at: 26, dir: 'in', body: 'Hi, I saw your ad for solitaire rings. Do you have anything around 0.5 carat?' },
      { at: 25.8, dir: 'out', by: 'ai', body: 'Hello Priya — yes. We have 0.50 ct solitaires in 18K white and rose gold at our Surat showroom. May I ask what your budget range is?' },
      { at: 25.2, dir: 'in', body: 'Budget is around 1.5 lakh. Is certification included?' },
      { at: 25.0, dir: 'out', by: 'ai', body: 'Every diamond above 0.30 ct comes with an IGI certificate at no extra cost. A 0.50 ct VS-clarity solitaire sits at ₹1,42,000 including making.' },
      { at: 3.5, dir: 'in', body: 'That works. Can I come and see it this Saturday?' },
    ],
    /** A real assessment, with the evidence quoting the messages above. */
    intent: {
      score: 88,
      band: 'hot',
      confidence: '0.820',
      summary:
        'Asked for a specific stone size, stated a budget, asked about certification and proposed a date to visit.',
      recommendedAction: 'Confirm the Saturday appointment and reserve the piece against the visit.',
      signals: [
        { key: 'budget_stated', label: 'Stated a budget', weight: 25, matched: true, evidence: 'Budget is around 1.5 lakh' },
        { key: 'visit_proposed', label: 'Proposed a visit', weight: 30, matched: true, evidence: 'Can I come and see it this Saturday?' },
        { key: 'spec_named', label: 'Named a specification', weight: 18, matched: true, evidence: 'anything around 0.5 carat' },
        { key: 'certification', label: 'Asked about certification', weight: 15, matched: true, evidence: 'Is certification included?' },
      ],
      requirements: { budget: '₹1,50,000', specification: '0.50 ct solitaire', timeline: 'This Saturday' },
    },
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
      { at: 50, dir: 'in', body: 'We are looking at a bridal set for a December wedding. Can the necklace be made shorter?' },
      { at: 49.5, dir: 'out', by: 'agent', body: 'Of course — we can adjust the length and the drop. Would you like to come in so we can take measurements?' },
      { at: 30, dir: 'in', body: 'Yes. Also please share what the making charges would be for the changes.' },
      { at: 29.2, dir: 'out', by: 'agent', body: 'I will put the revised quote together and send it across today.' },
      { at: 6, dir: 'in', body: 'Any update on the quote?' },
    ],
    intent: {
      score: 74,
      band: 'hot',
      confidence: '0.760',
      summary: 'Named an occasion with a date, requested a customisation and chased a quote.',
      recommendedAction: 'Send the revised making-charge quote today; the customer has chased it once.',
      signals: [
        { key: 'occasion_named', label: 'Named an occasion', weight: 22, matched: true, evidence: 'a December wedding' },
        { key: 'customisation', label: 'Requested a customisation', weight: 20, matched: true, evidence: 'Can the necklace be made shorter?' },
        { key: 'quote_chased', label: 'Chased a quote', weight: 26, matched: true, evidence: 'Any update on the quote?' },
      ],
      requirements: { occasion: 'Wedding', timeline: 'December' },
    },
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
    interest: 'Existing appointment',
    messages: [
      { at: 2.5, dir: 'in', body: 'Hi, I have an appointment tomorrow at 4pm. Could we move it to Friday?' },
    ],
    /*
     * DELIBERATELY UNASSESSABLE. One inbound line is not enough text to score,
     * and the honest record of that is a row with a null score and a reason —
     * not a low score, which would say "this customer is cold". The panel's
     * middle state is only reviewable if the seed produces it.
     */
    intent: {
      score: null,
      band: null,
      confidence: null,
      unavailableReason:
        'Only one message has been received. The policy needs at least three before it will score a conversation.',
      summary: null,
      recommendedAction: null,
      signals: [],
      requirements: {},
    },
    task: { title: 'Confirm the moved appointment with Ananya', priority: 'normal' },
  },
  {
    key: 'rohan',
    party: { id: 'demo_pty_rohan', name: 'Rohan Kapoor', phone: '919000000104' },
    storeId: 'ahmedabad-cg',
    subject: 'Price and certification',
    handling: 'human',
    status: 'closed',
    assignee: 'rina.rep@caratsense.in',
    adId: 'demo_ad_tennis_bracelet',
    interest: 'Tennis bracelet',
    messages: [
      { at: 96, dir: 'in', body: 'What is the price of the tennis bracelet in the ad, and is the diamond certified?' },
      { at: 95.4, dir: 'out', by: 'agent', body: 'It is ₹3,38,000 with 2.10 ct of VVS diamonds, IGI certified. Made to order, about three weeks.' },
      { at: 94, dir: 'in', body: 'Three weeks is too late for me, thank you.' },
      { at: 93.6, dir: 'out', by: 'agent', body: 'Understood — I will let you know if a ready piece comes in.' },
    ],
    /*
     * A REAL LOW SCORE, which is a different thing from an absent one: the
     * customer said no, and the record says so with the sentence they said it
     * in. This is the row that proves a low band is earned rather than defaulted.
     */
    intent: {
      score: 21,
      band: 'cold',
      confidence: '0.880',
      summary: 'Priced the item, then withdrew on lead time.',
      recommendedAction: 'Nothing to chase. Contact again only if a ready-stock piece arrives.',
      signals: [
        { key: 'price_asked', label: 'Asked for a price', weight: 12, matched: true, evidence: 'What is the price of the tennis bracelet' },
        { key: 'objection_timeline', label: 'Withdrew on timeline', weight: -35, matched: true, evidence: 'Three weeks is too late for me' },
      ],
      requirements: { timeline: 'Sooner than three weeks' },
    },
    task: null,
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
          data: { interest: t.interest, lastActivity: ago(t.messages[t.messages.length - 1].at) },
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
    // One assessment per thread, replaced on re-run rather than stacked — the
    // panel reads the LATEST, and a pile of identical rows would make the
    // history meaningless.
    await prisma.leadQualification.deleteMany({
      where: { organisationId, conversationId: conversation.id, provider: 'demo_seed' },
    });
    await prisma.leadQualification.create({
      data: {
        organisationId,
        partyId: party.id,
        leadId: lead.id,
        conversationId: conversation.id,
        method: 'rules',
        score: t.intent.score,
        confidence: t.intent.confidence,
        band: t.intent.band,
        recommendedAction: t.intent.recommendedAction,
        signals: t.intent.signals,
        requirements: t.intent.requirements,
        summary: t.intent.summary,
        unavailableReason: t.intent.unavailableReason ?? null,
        messagesConsidered: t.messages.length,
        // Named so it is obvious in the UI footer and in the database that this
        // score was seeded rather than produced by the qualification engine.
        provider: 'demo_seed',
        createdAt: ago(Math.min(...t.messages.map((m) => m.at))),
      },
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
  console.log('Open http://localhost:3177/conversations to work them.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
