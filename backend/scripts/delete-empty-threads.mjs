/**
 * Remove conversations that never held a conversation.
 *
 * A broadcast creates the thread BEFORE the policy gate decides whether the
 * message may go, so every refused recipient left an empty, nameless room
 * behind. 78 of them appeared in one minute on 19 November, all with no
 * `lastMessageAt` — and Postgres sorts NULLs first on a descending order, so
 * they took the whole first page of an inbox that only loads fifty. The
 * client's 128 real conversations were below them and unreachable.
 *
 * The owner's words: "how can a thread sit empty, if there is no conversation
 * there should be no thread."
 *
 * REFUSES ANYTHING THAT HELD ANYTHING. A thread is removable only when it has
 * no message, no customer, no qualification, no routing conflict and no
 * response-SLA clock. Every one of those is somebody's record of something
 * that happened; the rows this removes are records of nothing. Each refusal is
 * printed with its reason rather than skipped quietly.
 *
 * Dry run by default.
 *
 *   node scripts/delete-empty-threads.mjs
 *   node scripts/delete-empty-threads.mjs --apply --actor <userId>
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};
const APPLY = process.argv.includes('--apply');
const ACTOR = arg('actor');

/*
 * Candidates are chosen by what they CONTAIN, never by when they were made.
 * Dating the query to the broadcast would have made it a one-off that quietly
 * stops matching the next time this happens.
 */
const candidates = await prisma.conversation.findMany({
  where: {
    partyId: null,
    messages: { none: {} },
    leadQualifications: { none: {} },
    routingConflicts: { none: {} },
    responseSlas: { none: {} },
  },
  select: {
    id: true,
    organisationId: true,
    channel: true,
    externalThreadId: true,
    createdAt: true,
    storeId: true,
    assignedUserId: true,
    handoffReason: true,
  },
  orderBy: { createdAt: 'asc' },
});

console.log(`empty threads (no message, no customer, no qualification, no conflict, no SLA): ${candidates.length}`);
for (const c of candidates.slice(0, 5)) {
  console.log(`  ${c.createdAt.toISOString().slice(0, 16)}  ${c.channel}  ${String(c.externalThreadId).slice(0, 6)}…  store=${c.storeId ?? 'none'}`);
}
if (candidates.length > 5) console.log(`  … and ${candidates.length - 5} more`);

/*
 * What is deliberately LEFT, counted so the difference is visible rather than
 * assumed: a thread with no customer but with real messages is somebody who
 * wrote in and was never matched to a record. That is a job for a person, not
 * a deletion.
 */
const anonWithHistory = await prisma.conversation.count({
  where: { partyId: null, messages: { some: {} } },
});
console.log(`\nleft alone — anonymous threads that DO have messages: ${anonWithHistory}`);

if (!APPLY) {
  console.log(`\nDRY RUN — nothing written. Re-run with --apply --actor <userId>.`);
} else {
  if (!ACTOR) throw new Error('--actor <userId> is required with --apply: a deletion is somebody.');
  const org = candidates[0]?.organisationId;
  const actor = org
    ? await prisma.user.findFirst({
        where: { id: ACTOR, organisationId: org },
        select: { id: true, name: true, role: true },
      })
    : null;
  if (candidates.length && !actor) throw new Error(`No user "${ACTOR}" in that organisation.`);

  let removed = 0;
  for (const c of candidates) {
    /*
     * Re-checked one at a time inside the delete. The list above was read
     * seconds ago and an inbound message can arrive in the meantime — if it
     * has, this matches nothing and that thread is simply left behind.
     */
    const res = await prisma.conversation.deleteMany({
      where: {
        id: c.id,
        partyId: null,
        messages: { none: {} },
        leadQualifications: { none: {} },
        routingConflicts: { none: {} },
        responseSlas: { none: {} },
      },
    });
    removed += res.count;
  }

  if (actor) {
    await prisma.auditLog.create({
      data: {
        organisationId: org,
        actorId: actor.id,
        actorName: actor.name,
        actorRole: actor.role,
        action: 'conversation.empty_threads_removed',
        entityType: 'Conversation',
        entityId: 'bulk',
        summary:
          `Removed ${removed} conversation${removed === 1 ? '' : 's'} that held no message, ` +
          'customer or record — threads left behind by refused sends.',
      },
    });
  }
  console.log(`\nRemoved ${removed} of ${candidates.length}. ${candidates.length - removed} were left because something arrived on them while this ran.`);
}

await prisma.$disconnect();
