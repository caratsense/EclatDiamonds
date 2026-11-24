/**
 * Put a thread at the branch its own campaign rule names.
 *
 * A conversation takes its branch once, when it is created. If the matched
 * rule carried no branch at that moment — because it had not been given one
 * yet — the thread falls back to the branch of the WhatsApp number the message
 * arrived on. Every one of this tenant's numbers answers at Bandra Broadway,
 * so a Borivali enquiry silently became Anjali's instead of Mayank's.
 *
 * That fallback is never revisited: `storeId` is deliberately set once, because
 * moving an active thread, its history and its owner's pipeline is a decision
 * for a person. This script IS that person's decision, made in bulk and
 * recorded.
 *
 * ONLY moves a thread whose rule disagrees with it. A thread somebody assigned
 * by hand to a different branch is left alone — a hand assignment outranks a
 * rule, which is the same order the live routing applies.
 *
 *   node scripts/reroute-to-rule-branch.mjs
 *   node scripts/reroute-to-rule-branch.mjs --apply --actor <userId>
 *   node scripts/reroute-to-rule-branch.mjs --rule "Borivali - Bridal" --apply --actor <userId>
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const ACTOR = arg('actor');
const ONLY_RULE = arg('rule');

const org = await prisma.organisation.findFirst({ select: { id: true, name: true, settings: true } });
const rules = (org.settings ?? {}).crmAdSetRules ?? [];
const byId = new Map(rules.map((r) => [r.id, r]));

const threads = await prisma.conversation.findMany({
  where: { organisationId: org.id, matchedRuleId: { not: null } },
  select: {
    id: true, storeId: true, matchedRuleId: true, assignedUserId: true, handling: true,
    store: { select: { name: true } },
    assignedUser: { select: { id: true, name: true } },
  },
});

/*
 * Who should own it at the destination. The rule's own nominee first — it is
 * more specific than "whoever manages that branch" — then the branch's manager,
 * which is the same order the handoff already uses.
 */
async function ownerFor(rule, storeId) {
  if (rule.assignedUserId) {
    const named = await prisma.user.findFirst({
      where: { id: rule.assignedUserId, organisationId: org.id, isActive: true },
      select: { id: true, name: true },
    });
    if (named) return named;
  }
  const manager = await prisma.user.findFirst({
    where: { organisationId: org.id, isActive: true, role: 'store_manager', userStores: { some: { storeId } } },
    orderBy: [{ createdAt: 'asc' }],
    select: { id: true, name: true },
  });
  return manager;
}

const moves = [];
for (const t of threads) {
  const rule = byId.get(t.matchedRuleId);
  if (!rule?.storeId || rule.storeId === t.storeId) continue;
  if (ONLY_RULE && rule.name !== ONLY_RULE) continue;
  /*
   * A HUMAN's decision outranks a rule. Automation's does not.
   *
   * The first version of this test skipped any thread that had an owner, which
   * skipped both of the threads it was written to fix: the bot had handed them
   * over ("Campaign ... has no questions after its first reply; a person
   * continues") and the branch it picked the owner from was the wrong branch in
   * the first place. Skipping those protects the mistake rather than the
   * decision.
   *
   * The audit trail is what separates the two. A person reassigning a thread
   * writes a row; the router does not.
   */
  const humanMoved = await prisma.auditLog.findFirst({
    where: { organisationId: org.id, entityType: 'Conversation', entityId: t.id, action: { contains: 'assign' } },
    select: { actorName: true, createdAt: true },
  });
  if (humanMoved) {
    moves.push({
      thread: t,
      rule,
      skip: `${humanMoved.actorName} assigned this by hand on ${humanMoved.createdAt.toISOString().slice(0, 10)}`,
    });
    continue;
  }
  const dest = await prisma.store.findUnique({ where: { id: rule.storeId }, select: { id: true, name: true } });
  const owner = await ownerFor(rule, rule.storeId);
  moves.push({ thread: t, rule, dest, owner });
}

console.log(`${org.name}: ${threads.length} threads carry a campaign rule`);
const doable = moves.filter((m) => !m.skip);
const skipped = moves.filter((m) => m.skip);
console.log(`  at a branch their rule does not name : ${moves.length}`);
console.log(`  movable                              : ${doable.length}`);
console.log(`  left alone (a person decided)        : ${skipped.length}`);
for (const m of doable) {
  console.log(`    ${m.thread.id.slice(-6)}  ${m.rule.name}: ${m.thread.store?.name ?? 'no branch'} -> ${m.dest?.name} / ${m.owner?.name ?? 'nobody there'}`);
}
for (const m of skipped) console.log(`    ${m.thread.id.slice(-6)}  ${m.rule.name}: ${m.skip}`);

if (!doable.length) {
  console.log('\nNothing to move.');
} else if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply --actor <userId>.');
} else {
  if (!ACTOR) throw new Error('--actor <userId> is required with --apply: moving somebody\'s thread is somebody\'s decision.');
  const actor = await prisma.user.findFirst({ where: { id: ACTOR, organisationId: org.id }, select: { id: true, name: true, role: true } });
  if (!actor) throw new Error(`No user "${ACTOR}" in this organisation.`);

  let moved = 0;
  for (const m of doable) {
    await prisma.conversation.update({
      where: { id: m.thread.id },
      data: {
        storeId: m.dest.id,
        // Only claim an owner when there is one to claim; an unowned thread at
        // the right branch is better than one owned by nobody at the wrong one.
        ...(m.owner ? { assignedUserId: m.owner.id, handling: 'human' } : {}),
        handoffReason: `Moved to ${m.dest.name}: campaign "${m.rule.name}" routes there.`,
      },
    });
    await prisma.auditLog.create({
      data: {
        organisationId: org.id, actorId: actor.id, actorName: actor.name, actorRole: actor.role,
        action: 'conversation.rerouted', entityType: 'Conversation', entityId: m.thread.id,
        summary:
          `Moved from ${m.thread.store?.name ?? 'no branch'} to ${m.dest.name}` +
          `${m.owner ? ` and given to ${m.owner.name}` : ''}, to match campaign "${m.rule.name}".`,
      },
    });
    moved += 1;
  }
  console.log(`\nMoved ${moved}. Each one is in the audit trail with the rule that decided it.`);
}

await prisma.$disconnect();
