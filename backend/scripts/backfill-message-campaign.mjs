/**
 * Tell the messages a broadcast already sent which broadcast they came from.
 *
 * New sends record it themselves. These were written before they did, and
 * without it the inbox cannot show a customer's thread under the broadcast
 * that started it: `CampaignRecipient.messageId` is a plain column with no
 * relation behind it, so the filter reads the message's own stored
 * instruction instead.
 *
 * Only ADDS the field. The instruction is the delivery record — what was sent,
 * which template, which attachment — and is never otherwise rewritten here; a
 * message that already names a campaign is left alone.
 *
 *   node scripts/backfill-message-campaign.mjs
 *   node scripts/backfill-message-campaign.mjs --apply
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const linked = await prisma.campaignRecipient.findMany({
  where: { messageId: { not: null } },
  select: { messageId: true, campaignId: true, organisationId: true },
});
console.log(`recipients that produced a message: ${linked.length}`);

const byCampaign = new Map();
for (const r of linked) byCampaign.set(r.campaignId, (byCampaign.get(r.campaignId) ?? 0) + 1);
const names = await prisma.messagingCampaign.findMany({
  where: { id: { in: [...byCampaign.keys()] } },
  select: { id: true, name: true },
});
for (const c of names) console.log(`  ${byCampaign.get(c.id)}  ${c.name}`);

let already = 0;
const todo = [];
for (const r of linked) {
  const m = await prisma.message.findUnique({
    where: { id: r.messageId },
    select: { id: true, payload: true, organisationId: true },
  });
  if (!m) continue; // the message is gone; the recipient row is the only record
  const omni = m.payload?.omnichannel;
  if (!omni || typeof omni !== 'object') continue;
  if (typeof omni.campaignId === 'string') { already += 1; continue; }
  todo.push({ id: m.id, payload: { ...m.payload, omnichannel: { ...omni, campaignId: r.campaignId } } });
}

console.log(`\nalready named their campaign : ${already}`);
console.log(`to be named                  : ${todo.length}`);

if (!todo.length) {
  console.log('\nNothing to backfill.');
} else if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply.');
} else {
  let done = 0;
  for (let i = 0; i < todo.length; i += 100) {
    const chunk = todo.slice(i, i + 100);
    await prisma.$transaction(
      chunk.map((m) => prisma.message.update({ where: { id: m.id }, data: { payload: m.payload } })),
    );
    done += chunk.length;
  }
  console.log(`\nNamed the campaign on ${done} messages.`);
}

await prisma.$disconnect();
