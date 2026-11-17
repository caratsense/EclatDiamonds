/**
 * Remove the seeded demo CRM rows, and only those.
 *
 * DRY RUN BY DEFAULT. Pass --apply to write. Take a backup first:
 *   node scripts/db-backup.mjs
 *
 * Scope is provenance, never a date. The client asked for "anything before
 * this month", which on this database would delete Gargi Srivastava,
 * namu1507, Jenil Doshi, Sadananda Mohanty and divyangsosa11 -- real people
 * from real Instagram and Facebook ads, with real phone numbers and real
 * leads. Those are October rows and they are not test data.
 *
 * The rows removed here are the ones scripts/seed-conversations.mjs wrote, and
 * they are identified by the markers that script itself stamps:
 *
 *   Party.id                        demo_pty_*
 *   Party.phone                     9190000001xx  (reserved, not dialable)
 *   Lead.originKey                  demo_seed:*
 *   Lead.ref                        LD-DEMO-*
 *   Conversation.externalThreadId   demo-thread-*  (real ones are a phone)
 *
 * A real record cannot look like any of those. Anything that does not match is
 * left alone -- this script has no "probably test" branch, because that is the
 * judgement that loses somebody's customers.
 *
 * Explicitly NOT touched: staff accounts, stock, products, the Gati sync, and
 * every real conversation. `cleanup-demo.mjs` in this folder is a different
 * and far blunter thing -- it calls deleteMany({}) with no filter at all --
 * and must not be confused with this.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const ORG = process.env.AUDIT_ORG_ID ?? 'org_eclat';

const DEMO_PARTY = {
  OR: [{ id: { startsWith: 'demo_pty_' } }, { phone: { startsWith: '91900000' } }],
};
const DEMO_LEAD = {
  OR: [{ originKey: { startsWith: 'demo_seed:' } }, { ref: { startsWith: 'LD-DEMO-' } }],
};
const DEMO_CONVO = { externalThreadId: { startsWith: 'demo-thread-' } };

/**
 * Relations that REFUSE to let a Party go (onDelete: Restrict), other than the
 * three this script removes itself.
 *
 * A seeded demo customer should have none of these. If one does, the row is
 * not what this script thinks it is -- so it stops and says which, rather than
 * widening the blast radius to make its own delete succeed. A sale or a
 * payment attached to a "demo" customer is a reason to look, not to force.
 */
const PARTY_BLOCKERS = [
  ['sale', (p) => ({ partyId: { in: p } })],
  ['payment', (p) => ({ partyId: { in: p } })],
  ['ledgerEntry', (p) => ({ partyId: { in: p } })],
  ['checkIn', (p) => ({ partyId: { in: p } })],
  ['manufacturingOrder', (p) => ({ partyId: { in: p } })],
  ['customOrder', (p) => ({ partyId: { in: p } })],
  ['schemeMember', (p) => ({ partyId: { in: p } })],
  ['returnRecord', (p) => ({ partyId: { in: p } })],
  ['loyaltyAccount', (p) => ({ partyId: { in: p } })],
  ['user', (p) => ({ partyId: { in: p } })],
];

const pad = (v, w = 6) => String(v).padStart(w);

async function main() {
  console.log(APPLY ? '=== APPLY — rows will be deleted ===' : '=== DRY RUN (pass --apply to write) ===');
  console.log(`organisation: ${ORG}\n`);

  const scoped = { organisationId: ORG };

  const parties = await prisma.party.findMany({
    where: { ...scoped, ...DEMO_PARTY },
    select: { id: true, name: true, phone: true },
  });
  const partyIds = parties.map((p) => p.id);

  const leads = await prisma.lead.findMany({
    where: { ...scoped, ...DEMO_LEAD },
    select: { id: true, ref: true },
  });
  const convos = await prisma.conversation.findMany({
    where: { ...scoped, ...DEMO_CONVO },
    select: { id: true, externalThreadId: true },
  });

  // Quotes go with the demo lead or the demo customer they belong to.
  const quotes = await prisma.quote.findMany({
    where: {
      ...scoped,
      OR: [
        ...(leads.length ? [{ leadId: { in: leads.map((l) => l.id) } }] : []),
        ...(partyIds.length ? [{ partyId: { in: partyIds } }] : []),
      ],
    },
    select: { id: true },
  });

  const messages = convos.length
    ? await prisma.message.count({ where: { conversationId: { in: convos.map((c) => c.id) } } })
    : 0;

  console.log('MATCHED BY A SEED MARKER');
  console.log('------------------------');
  console.log(`  customers (Party)        ${pad(parties.length)}`);
  console.log(`  leads                    ${pad(leads.length)}`);
  console.log(`  conversations            ${pad(convos.length)}`);
  console.log(`  messages (cascade)       ${pad(messages)}`);
  console.log(`  quotations               ${pad(quotes.length)}`);

  if (parties.length) {
    console.log('\n  the customers:');
    for (const p of parties) console.log(`    ${String(p.name ?? '—').padEnd(22)} ${p.phone ?? ''}`);
  }

  // ── Refuse to proceed if a "demo" customer carries real business records ──
  const blocked = [];
  if (partyIds.length) {
    for (const [model, where] of PARTY_BLOCKERS) {
      const n = await prisma[model].count({ where: where(partyIds) });
      if (n > 0) blocked.push([model, n]);
    }
  }
  if (blocked.length) {
    console.log('\nSTOPPING — these demo customers carry records this script will not delete:');
    for (const [model, n] of blocked) console.log(`  ${model.padEnd(22)} ${pad(n)}`);
    console.log(
      '\nThat means the classification is wrong, or somebody traded against a seeded\n' +
        'customer. Either way it is a question for a person, not something to force.',
    );
    return;
  }

  if (!parties.length && !leads.length && !convos.length && !quotes.length) {
    console.log('\nNothing matches a seed marker. Nothing to do.');
    return;
  }

  if (!APPLY) {
    console.log('\nDry run — nothing deleted. Re-run with --apply once the list above is right.');
    return;
  }

  // Order matters: Quote and Conversation and Lead all Restrict the Party, and
  // Quote Restricts the Lead. Children (messages, notes, tags, touches) are
  // Cascade and go on their own.
  const result = await prisma.$transaction(async (tx) => {
    const q = quotes.length
      ? await tx.quote.deleteMany({ where: { id: { in: quotes.map((x) => x.id) } } })
      : { count: 0 };
    const c = convos.length
      ? await tx.conversation.deleteMany({ where: { id: { in: convos.map((x) => x.id) } } })
      : { count: 0 };
    const l = leads.length
      ? await tx.lead.deleteMany({ where: { id: { in: leads.map((x) => x.id) } } })
      : { count: 0 };
    const p = partyIds.length
      ? await tx.party.deleteMany({ where: { id: { in: partyIds } } })
      : { count: 0 };
    return { quotes: q.count, conversations: c.count, leads: l.count, parties: p.count };
  });

  console.log('\nDELETED');
  console.log('-------');
  for (const [k, v] of Object.entries(result)) console.log(`  ${k.padEnd(22)} ${pad(v)}`);

  const left = await prisma.party.count({ where: { ...scoped, ...DEMO_PARTY } });
  console.log(`\nDemo customers still present: ${left} (expected 0)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
