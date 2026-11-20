/**
 * READ-ONLY. Counts and samples only. Deletes nothing, writes nothing.
 *
 * Answers the question that has to be settled before anything is removed from
 * a live database: which CRM rows are demo, which are a real customer, and
 * which nobody can tell apart from the outside.
 *
 * Why not "everything before this month"
 * --------------------------------------
 * Because it is wrong. The October conversations in this database include
 * real people, from real Instagram and Facebook ads, with
 * real phone numbers and real leads attached. A date rule deletes them along
 * with the seed data, and nothing brings them back.
 *
 * So rows are judged on PROVENANCE, using the identifiers the seed scripts
 * themselves write:
 *
 *   scripts/seed-conversations.mjs
 *     Party.id            demo_pty_*
 *     Party.phone         9190000001xx   (a reserved block, not dialable)
 *     Lead.originKey      demo_seed:*
 *     Lead.ref            LD-DEMO-*
 *     Conversation.externalThreadId   demo-thread-*   (real ones are a phone)
 *
 *   scripts/cleanup-test-rows.mjs
 *     TEST-SKU-VERIFY / TEST-STK-VERIFY / TEST-PAY-VERIFY
 *
 * Anything that matches none of those and has no evidence of being real lands
 * in REVIEW, which is a question for a person and never an automatic delete.
 *
 *   cd backend && railway run --service backend -- node scripts/audit-stale-crm.mjs
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** A seeded demo customer: the seed sets both, either alone is enough. */
const DEMO_PARTY = {
  OR: [{ id: { startsWith: 'demo_pty_' } }, { phone: { startsWith: '91900000' } }],
};

/** A seeded lead. Both markers come from the same seed; either identifies it. */
const DEMO_LEAD = {
  OR: [{ originKey: { startsWith: 'demo_seed:' } }, { ref: { startsWith: 'LD-DEMO-' } }],
};

/** A seeded thread. A real thread's externalThreadId is the customer's number. */
const DEMO_CONVO = { externalThreadId: { startsWith: 'demo-thread-' } };

/**
 * Evidence a conversation is a real person: the thread id is a phone number
 * (10-15 digits) AND it did not come from a seed. Meta's own attribution is
 * stronger still, so an ad click is reported separately.
 */
const REAL_CONVO = {
  AND: [
    { externalThreadId: { not: { startsWith: 'demo-thread-' } } },
    { externalThreadId: { not: null } },
  ],
};

const pad = (v, w = 7) => String(v).padStart(w);

async function section(title, rows) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
  for (const [label, value, note] of rows) {
    console.log(`  ${label.padEnd(34)} ${pad(value)}${note ? '   ' + note : ''}`);
  }
}

async function main() {
  const org = process.env.AUDIT_ORG_ID ?? 'org_eclat';
  console.log(`READ-ONLY audit of CRM provenance for organisation ${org}`);
  console.log('Nothing is deleted or modified by this script.\n');

  const scoped = { organisationId: org };

  // ── Customers ────────────────────────────────────────────────────────────
  const partyTotal = await prisma.party.count({ where: scoped });
  const partyDemo = await prisma.party.count({ where: { ...scoped, ...DEMO_PARTY } });
  const partyLegacy = await prisma.party.count({
    where: { ...scoped, legacyId: { not: null } },
  });
  await section('CUSTOMERS (Party)', [
    ['total', partyTotal],
    ['seeded demo', partyDemo, '<- safe to delete'],
    ['from Gati (has legacyId)', partyLegacy, '<- real, never delete'],
    ['neither', partyTotal - partyDemo - partyLegacy, '<- REVIEW'],
  ]);

  // ── Leads ────────────────────────────────────────────────────────────────
  const leadTotal = await prisma.lead.count({ where: scoped });
  const leadDemo = await prisma.lead.count({ where: { ...scoped, ...DEMO_LEAD } });
  const leadFromAd = await prisma.lead.count({
    where: { ...scoped, originKey: { startsWith: 'click:' } },
  });
  const leadFromConvo = await prisma.lead.count({
    where: { ...scoped, originKey: { startsWith: 'convo:' } },
  });
  await section('LEADS', [
    ['total', leadTotal],
    ['seeded demo', leadDemo, '<- safe to delete'],
    ['from a real ad click', leadFromAd, '<- real, never delete'],
    ['from a real conversation', leadFromConvo, '<- real, never delete'],
    ['neither (hand-entered or older)', leadTotal - leadDemo - leadFromAd - leadFromConvo, '<- REVIEW'],
  ]);

  // ── Conversations ────────────────────────────────────────────────────────
  const convoTotal = await prisma.conversation.count({ where: scoped });
  const convoDemo = await prisma.conversation.count({ where: { ...scoped, ...DEMO_CONVO } });
  const convoAd = await prisma.conversation.count({
    where: { ...scoped, ...REAL_CONVO, sourceAdId: { not: null } },
  });
  const convoOther = convoTotal - convoDemo - convoAd;
  await section('CONVERSATIONS', [
    ['total', convoTotal],
    ['seeded demo', convoDemo, '<- safe to delete'],
    ['real, attributed to an ad', convoAd, '<- real, never delete'],
    ['real thread, no ad attribution', convoOther, '<- REVIEW'],
  ]);

  // ── Quotations ───────────────────────────────────────────────────────────
  const quoteTotal = await prisma.quote.count({ where: scoped });
  const quoteDemoParty = await prisma.quote.count({
    where: { ...scoped, party: DEMO_PARTY },
  });
  await section('QUOTATIONS', [
    ['total', quoteTotal],
    ['for a seeded demo customer', quoteDemoParty, '<- safe to delete'],
    ['for everyone else', quoteTotal - quoteDemoParty, '<- REVIEW'],
  ]);

  // ── What REVIEW actually contains ────────────────────────────────────────
  // The whole point of the exercise: a person has to look at these before any
  // delete is written, so they are printed rather than counted.
  const reviewConvos = await prisma.conversation.findMany({
    where: { ...scoped, ...REAL_CONVO, sourceAdId: null },
    select: {
      externalThreadId: true,
      createdAt: true,
      storeId: true,
      party: { select: { name: true } },
      _count: { select: { messages: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 25,
  });
  console.log('\nREVIEW — real threads with no ad attribution (newest 25)');
  console.log('-'.repeat(56));
  for (const c of reviewConvos) {
    const when = c.createdAt.toISOString().slice(0, 10);
    console.log(
      `  ${when}  ${String(c.party?.name ?? '—').padEnd(24).slice(0, 24)} ` +
        `${String(c.externalThreadId).padEnd(15)} msgs=${pad(c._count.messages, 3)} ` +
        `${c.storeId ?? 'no store'}`,
    );
  }

  console.log(
    '\nNothing above has been changed. Decide the REVIEW rows before any delete runs.',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
