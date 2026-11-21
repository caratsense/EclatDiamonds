/**
 * Re-send the failed recipients of a broadcast that already exists.
 *
 * Does exactly what CampaignsService.retryFailed does — the same three writes
 * in the same order — rather than inventing a second way to retry. It is a
 * script only because the owner asked for the re-send to happen without the
 * client touching the screen again, and because no one should have to press a
 * button to recover from our own bug.
 *
 * Deliberately NOT a new campaign. The audience, the template and the approval
 * are the ones she already signed off; a second campaign would be a second
 * thing to explain and would re-ask the questions she has already answered.
 *
 * Only `failed` rows move. An `excluded` recipient was refused for a reason
 * that still stands (no usable number), and a `sent` one must never be sent
 * twice — the campaign's own retry draws the line in the same place.
 *
 *   node scripts/retry-campaign.mjs --campaign "<name or id>"
 *   node scripts/retry-campaign.mjs --campaign "<name or id>" --apply --actor <userId>
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
/*
 * Re-send to N people rather than all of them.
 *
 * A re-send to the whole audience is the only way to prove a delivery fix
 * works, and also the most expensive way to discover it doesn't — the nails
 * event failed 126 at a time, three times over. One recipient first costs one
 * message and answers the same question.
 */
const LIMIT = arg('limit') ? Number(arg('limit')) : null;
/*
 * Reclaim the people a RULE refused, when the rule has since changed.
 *
 * `excluded` normally means a refusal that still stands, and the retry leaves
 * it alone for good reason: re-sending to somebody who replied STOP is the
 * worst thing this script could do. But a refusal is only as current as the
 * policy that made it. When the owner changed the marketing basis to implied,
 * 78 people who had been refused for "no recorded consent" an hour earlier
 * stayed frozen at that moment, excluded from a rule that no longer existed.
 *
 * Only `policy_refused_at_send` rows are reclaimed — never a blocked customer,
 * never an unusable number, and never a STOP. And the policy runs AGAIN at
 * send time for every one of them, so anyone the current rules still refuse is
 * simply refused again. This widens who gets re-examined, not who gets sent to.
 */
const INCLUDE_REFUSED = process.argv.includes('--include-policy-refused');
const RECLAIMABLE = 'policy_refused_at_send';
/*
 * HOW RECENTLY THIS PERSON WAS LAST MESSAGED, and a refusal to do it again.
 *
 * Meta caps how much marketing one person receives (error 131049), per
 * recipient, over a rolling window. Re-sending the same template to the same
 * list is therefore not free: it spends that allowance, and the people it
 * burns are refused for hours afterwards.
 *
 * This is not theoretical. On the nails-event broadcast the outcome tracked
 * the number of attempts almost exactly — 80% of the people tried twice got
 * it, 9% of the people tried three times did, and nobody tried four times did.
 * The retries were debugging a delivery bug, and they made the delivery worse.
 *
 *   attempts  reached  refused
 *     2         143      36
 *     3           2      21
 *     4           0       2
 *
 * So a recipient messaged within this window is left out unless somebody
 * deliberately says otherwise. `--force` is the override and prints what it
 * is overriding.
 */
const COOLDOWN_HOURS = arg('cooldown-hours') ? Number(arg('cooldown-hours')) : 24;
const FORCE = process.argv.includes('--force');
if (!Number.isFinite(COOLDOWN_HOURS) || COOLDOWN_HOURS < 0) {
  throw new Error(`--cooldown-hours must be a number of hours, not "${arg('cooldown-hours')}".`);
}
if (LIMIT !== null && (!Number.isInteger(LIMIT) || LIMIT < 1)) {
  throw new Error(`--limit must be a whole number of people, not "${arg('limit')}".`);
}
const SEND_JOB = 'campaign.send';

if (!TARGET) throw new Error('--campaign "<name or id>" is required.');

const campaign = await prisma.messagingCampaign.findFirst({
  where: { OR: [{ id: TARGET }, { name: TARGET }] },
  select: {
    id: true, organisationId: true, name: true, status: true,
    templateName: true, templateLanguage: true,
  },
});
if (!campaign) throw new Error(`No broadcast called "${TARGET}".`);

const counts = await prisma.campaignRecipient.groupBy({
  by: ['status'],
  where: { campaignId: campaign.id },
  _count: { _all: true },
});
console.log(`"${campaign.name}" [${campaign.status}] template=${campaign.templateName}:${campaign.templateLanguage}`);
console.log(`  ${counts.map((c) => `${c.status}=${c._count._all}`).join(', ')}`);

/*
 * `dead` as well as `failed`.
 *
 * A recipient is marked dead once its attempts are spent, and `attempts` is
 * never reset — so a row that failed twice can never be tried again, however
 * thoroughly the cause has been fixed since. The app's own retry draws the
 * line at `failed` for that reason and would leave these 125 stranded.
 */
const reclaimable = INCLUDE_REFUSED
  ? await prisma.campaignRecipient.count({
      where: {
        organisationId: campaign.organisationId,
        campaignId: campaign.id,
        status: 'excluded',
        exclusionReason: RECLAIMABLE,
      },
    })
  : 0;

const failed =
  (counts.find((c) => c.status === 'failed')?._count._all ?? 0) +
  (counts.find((c) => c.status === 'dead')?._count._all ?? 0) +
  reclaimable;
const alreadySent = (counts.find((c) => c.status === 'sent')?._count._all ?? 0)
  + (counts.find((c) => c.status === 'delivered')?._count._all ?? 0)
  + (counts.find((c) => c.status === 'read')?._count._all ?? 0);
/*
 * Anyone messaged inside the cooldown is held back, and said so out loud.
 * `sentAt` is when the provider last took a message for them; a recipient
 * that has never reached the provider has none and is always eligible.
 */
const cooldownSince = new Date(Date.now() - COOLDOWN_HOURS * 3600_000);
const tooSoon = FORCE
  ? 0
  : await prisma.campaignRecipient.count({
      where: {
        organisationId: campaign.organisationId,
        campaignId: campaign.id,
        OR: [
          { status: { in: ['failed', 'dead'] } },
          ...(INCLUDE_REFUSED ? [{ status: 'excluded', exclusionReason: RECLAIMABLE }] : []),
        ],
        sentAt: { gte: cooldownSince },
      },
    });
if (tooSoon) {
  console.log(
    `\n  HELD BACK: ${tooSoon} were already messaged in the last ${COOLDOWN_HOURS}h.`,
  );
  console.log('  Messaging them again spends their marketing allowance with Meta and is');
  console.log('  the most likely way to have them refused. Use --force to override, or wait.');
}
const cooldownClause = FORCE ? {} : { OR: [{ sentAt: null }, { sentAt: { lt: cooldownSince } }] };
// What the run would ACTUALLY do, cooldown subtracted. A figure that ignores
// the hold-back is the figure somebody plans around and then has to explain.
const eligible = Math.max(failed - tooSoon, 0);
console.log(`
  would re-send to : ${LIMIT === null ? eligible : `${Math.min(LIMIT, eligible)} of ${eligible} (--limit)`}`);
if (tooSoon) {
  console.log(`  (${failed} are retryable; ${tooSoon} of them are inside the ${COOLDOWN_HOURS}h cooldown)`);
}
const excluded = counts.find((c) => c.status === 'excluded')?._count._all ?? 0;
if (reclaimable) {
  console.log(`  of those, ${reclaimable} were refused by a rule that has since changed`);
}
console.log(`  left alone       : ${alreadySent} already received it, ` +
  `${excluded - reclaimable} refused for a reason that still stands`);

/*
 * The template's picture, checked BEFORE the re-send rather than discovered
 * 126 refusals later. A media header with no file to send is the exact fault
 * this retry exists to recover from, so repeating it would be unforgivable.
 */
const asset = await prisma.integrationAsset.findFirst({
  where: {
    organisationId: campaign.organisationId,
    kind: 'message_template',
    externalId: `${campaign.templateName}:${campaign.templateLanguage}`,
  },
  select: { metadata: true, providerOwnershipVerified: true },
});
const meta = asset?.metadata ?? {};
const header = typeof meta.headerFormat === 'string' ? meta.headerFormat.toUpperCase() : null;
if (header && header !== 'TEXT') {
  const source = meta.headerImageKey ? 'our stored copy' : meta.headerImageUrl ? "the provider's file" : null;
  console.log(`  header           : ${header}, from ${source ?? 'NOTHING — this will fail again'}`);
  if (!source) {
    console.log('\nREFUSED. The template needs a picture on every send and there is none to send.');
    await prisma.$disconnect();
    process.exit(1);
  }
}
if (!asset?.providerOwnershipVerified) {
  console.log('  WARNING: the provider has not confirmed this template as sendable since the last sync.');
}

if (!failed) {
  console.log('\nNothing to re-send.');
} else if (!APPLY) {
  console.log(`\nDRY RUN — nothing written. Re-run with --apply --actor <userId>.`);
} else {
  if (!ACTOR) throw new Error('--actor <userId> is required with --apply.');
  const actor = await prisma.user.findFirst({
    where: { id: ACTOR, organisationId: campaign.organisationId },
    select: { id: true, name: true, role: true },
  });
  if (!actor) throw new Error(`No user "${ACTOR}" in that organisation.`);

  // The old message is let go of as well: leaving it linked would have this
  // attempt's outcome read off the previous attempt's refusal.

  // Oldest first, so a --limit run re-sends the people who have been waiting
  // longest rather than an arbitrary slice.
  const picked = LIMIT === null
    ? null
    : await prisma.campaignRecipient.findMany({
        where: {
          organisationId: campaign.organisationId,
          campaignId: campaign.id,
          OR: [
            { status: { in: ['failed', 'dead'] } },
            ...(INCLUDE_REFUSED
              ? [{ status: 'excluded', exclusionReason: RECLAIMABLE }]
              : []),
          ],
          ...cooldownClause,
        },
        orderBy: { createdAt: 'asc' },
        take: LIMIT,
        select: { id: true },
      });

  const reset = await prisma.campaignRecipient.updateMany({
    where: {
      organisationId: campaign.organisationId,
      campaignId: campaign.id,
      OR: [
        { status: { in: ['failed', 'dead'] } },
        ...(INCLUDE_REFUSED
          ? [{ status: 'excluded', exclusionReason: RECLAIMABLE }]
          : []),
      ],
      ...cooldownClause,
      ...(picked ? { id: { in: picked.map((r) => r.id) } } : {}),
    },
    /*
     * `attempts` IS DELIBERATELY LEFT ALONE. It is the generation number in
     * the send's idempotency key, so zeroing it makes this attempt reuse the
     * key the last one spent -- and the send becomes a no-op that hands back
     * the message already refused, which is exactly how three re-sends of the
     * nails-event broadcast reached nobody. A row that fails again from here
     * lands on 'dead', which is the honest outcome for a second failure.
     */
    data: { status: 'pending', lastError: null, messageId: null, exclusionReason: null },
  });
  await prisma.messagingCampaign.update({
    where: { id: campaign.id },
    data: { status: 'sending', finishedAt: null },
  });
  // No idempotency key, exactly as enqueueSend does: the send job re-enqueues
  // itself per chunk and a key would make the second chunk a no-op.
  const job = await prisma.jobTask.create({
    data: {
      kind: SEND_JOB,
      payload: { campaignId: campaign.id },
      organisationId: campaign.organisationId,
      runAt: new Date(),
      maxAttempts: 5,
      createdById: actor.id,
    },
    select: { id: true },
  });
  await prisma.auditLog.create({
    data: {
      organisationId: campaign.organisationId,
      actorId: actor.id,
      actorName: actor.name,
      actorRole: actor.role,
      action: 'campaign.retried',
      entityType: 'MessagingCampaign',
      entityId: campaign.id,
      summary: `Retried ${reset.count} failed recipients on "${campaign.name}".`,
    },
  });
  console.log(`\nRe-queued ${reset.count} recipients. Send job ${job.id}.`);
}

await prisma.$disconnect();
