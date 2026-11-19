/**
 * Remove a broadcast that never reached anybody.
 *
 * The client's first broadcast failed outright — every recipient refused at
 * send time, nothing delivered — and she asked for the record gone rather than
 * sitting at the top of her list looking like a failure she has to explain.
 *
 * REFUSES TO DELETE A REAL SEND. If any recipient ever reached `sent`,
 * `delivered` or `read`, or carries a Message row, the campaign is the only
 * record that those customers were contacted and it stays. That guard is the
 * reason this script can exist at all: an attempt that reached nobody is
 * bookkeeping, a send that reached somebody is history.
 *
 * The audit entries are NOT deleted. They live in their own table, they name
 * who created and approved it, and removing the campaign does not make those
 * untrue — it is the trail that says this happened at all. One more is written
 * to say it was removed and by whom.
 *
 *   node scripts/delete-campaign.mjs --campaign "<name or id>"
 *   node scripts/delete-campaign.mjs --campaign "<name or id>" --apply --actor <userId>
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};
const APPLY = process.argv.includes('--apply');
const TARGET = arg('campaign');
const ACTOR = arg('actor');

if (!TARGET) throw new Error('--campaign "<name or id>" is required.');

const campaign = await prisma.messagingCampaign.findFirst({
  where: { OR: [{ id: TARGET }, { name: TARGET }] },
  select: { id: true, organisationId: true, name: true, status: true, createdAt: true },
});
if (!campaign) throw new Error(`No broadcast called "${TARGET}".`);

const total = await prisma.campaignRecipient.count({ where: { campaignId: campaign.id } });
const delivered = await prisma.campaignRecipient.count({
  where: { campaignId: campaign.id, status: { in: ['sent', 'delivered', 'read'] } },
});
const withMessage = await prisma.campaignRecipient.count({
  where: { campaignId: campaign.id, messageId: { not: null } },
});

console.log(`"${campaign.name}" [${campaign.status}] created ${campaign.createdAt.toISOString().slice(0, 16)}`);
console.log(`  recipient rows     : ${total}`);
console.log(`  ever sent          : ${delivered}`);
console.log(`  linked to a message: ${withMessage}`);

if (delivered > 0 || withMessage > 0) {
  console.log(
    `\nREFUSED. ${delivered || withMessage} of these customers were actually contacted, and this ` +
      'campaign is the record of it. Cancel it instead; it will stop sending without erasing who was reached.',
  );
  await prisma.$disconnect();
  process.exit(1);
}

if (!APPLY) {
  console.log(`\nDRY RUN — nothing written. Re-run with --apply --actor <userId> to delete it and its ${total} recipient rows.`);
} else {
  if (!ACTOR) throw new Error('--actor <userId> is required with --apply: a deletion is somebody.');
  const actor = await prisma.user.findFirst({
    where: { id: ACTOR, organisationId: campaign.organisationId },
    select: { id: true, name: true, role: true },
  });
  if (!actor) throw new Error(`No user "${ACTOR}" in this organisation.`);

  // The audit row first: if the delete then fails, a line saying it was
  // attempted is better than a deletion nobody can see.
  await prisma.auditLog.create({
    data: {
      organisationId: campaign.organisationId,
      actorId: actor.id,
      actorName: actor.name,
      actorRole: actor.role,
      action: 'campaign.deleted',
      entityType: 'MessagingCampaign',
      entityId: campaign.id,
      summary:
        `Deleted the broadcast "${campaign.name}" (${campaign.status}); ` +
        `it reached nobody — ${total} recipients, none sent.`,
    },
  });
  // Recipients cascade from the campaign row (schema: onDelete: Cascade).
  await prisma.messagingCampaign.delete({ where: { id: campaign.id } });
  console.log(`\nDeleted, with its ${total} recipient rows. The audit trail is intact.`);
}

await prisma.$disconnect();
