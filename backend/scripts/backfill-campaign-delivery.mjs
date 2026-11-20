/**
 * Correct the campaigns that reported a send which never happened.
 *
 * On 20 November a broadcast of 126 people read "125 of 126 sent" on the
 * campaign screen. Meta had refused all 125 with "(#132012) Parameter format
 * does not match format in the created template": nobody received anything. The
 * send loop wrote 'sent' the instant each message was handed to the outbox, and
 * tried to store the message id off the wrong property, so not one recipient
 * row carried the link that would have let the refusal find its way back.
 *
 * src/crm/campaigns.service.ts no longer does either. This is for the rows that
 * were already written, so the owner and the client stop reading a screen that
 * says 125 people were invited to an event they were never told about.
 *
 * HOW A MESSAGE IS FOUND AGAIN, with the link missing. Every campaign send goes
 * through `queueToContact` with `idempotencyKey: campaign:<campaignId>:<id>`,
 * and the outbox writes that key onto its 'message.queued' activity event as
 * `omnichannel:queue:campaign:<campaignId>:<recipientId>`, with the Message id
 * in `entityId`. That event is the recipient-to-message link, recorded for
 * idempotency and now the only copy of it. It is read, never written.
 *
 * WHAT DECIDES THE NEW STATUS is src/crm/campaign-delivery.ts — the same
 * functions the running service uses, imported rather than restated, so this
 * cannot correct a row to something the live code would disagree with.
 *
 * `sentAt` IS CLEARED on a row that turns out to have failed, but only where
 * the provider never gave the message an id — proof it never took it. A message
 * the provider accepted and then rejected did leave, and when it left is worth
 * keeping.
 *
 * NOTHING IS DELETED and no audit rows are written. The campaign's own counts
 * are read off the recipient rows, so correcting those corrects every figure on
 * both screens; only the campaign's status and `finishedAt` are written beside
 * them, and `finishedAt` is left as it was wherever it already has a value.
 *
 * DRY RUN BY DEFAULT. Writes only with --apply, so the plan can be read on real
 * data before any row changes. --apply also needs --campaign: one run corrects
 * one broadcast. On a database that is not on this machine it needs --host as
 * well, typed as the first line of the report prints it, so a DATABASE_URL left
 * over from other work is not written to by mistake.
 *
 *   node scripts/backfill-campaign-delivery.mjs                        # report only, every campaign
 *   node scripts/backfill-campaign-delivery.mjs --campaign <id>        # report only, one campaign
 *   node scripts/backfill-campaign-delivery.mjs --apply --campaign <id>              # write, local database
 *   node scripts/backfill-campaign-delivery.mjs --apply --campaign <id> --host <host:port>   # write, hosted database
 *
 * Needs Node 22.18 or newer, which loads the TypeScript import below as it is.
 */
import { PrismaClient } from '@prisma/client';
// The product's own rule rather than a copy of it. The file holds no decorators
// and no parameter properties on purpose — Node's strip-only mode refuses both.
import { campaignOutcome, nextRecipientStatus } from '../src/crm/campaign-delivery.ts';

const QUEUE_EVENT_PREFIX = 'omnichannel:queue:campaign:';

function readArgs(argv) {
  const args = { apply: false, campaignId: null, host: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--campaign') args.campaignId = argv[++i] ?? null;
    else if (argv[i] === '--host') args.host = argv[++i] ?? null;
    else throw new Error(`Unrecognised argument: ${argv[i]}`);
  }
  return args;
}

/** The host in DATABASE_URL, so the report names the database it just read. */
function databaseHost() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  const parsed = new URL(url);
  return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
}

/**
 * The plan for one campaign: what each recipient should say, and what the
 * campaign should say once they all do.
 */
function planCampaign(campaign, recipients, messageByRecipient) {
  const links = [];
  const transitions = [];
  const unrecoverable = [];
  const counts = {};

  for (const recipient of recipients) {
    const message = messageByRecipient.get(recipient.id) ?? null;
    if (!recipient.messageId && message) {
      links.push({ recipientId: recipient.id, messageId: message.id });
    }
    if (!message) {
      // Either it never reached the outbox — the one row that failed on an
      // unusable number did not — or its activity event is gone. Left exactly
      // as it is, and reported, rather than guessed at.
      if (recipient.status === 'sent') unrecoverable.push(recipient.id);
      counts[recipient.status] = (counts[recipient.status] ?? 0) + 1;
      continue;
    }

    const next = nextRecipientStatus({
      current: recipient.status,
      attempts: recipient.attempts,
      messageStatus: message.status,
    });
    const settled = next ?? recipient.status;
    counts[settled] = (counts[settled] ?? 0) + 1;
    if (!next) continue;

    const failed = next === 'failed' || next === 'dead';
    transitions.push({
      recipientId: recipient.id,
      from: recipient.status,
      to: next,
      messageStatus: message.status,
      error: failed ? message.error : null,
      // Only where the provider never gave it an id, which is proof it never
      // took the message.
      clearSentAt: failed && !message.externalId && !!recipient.sentAt,
    });
  }

  const outcome = campaignOutcome(counts);
  return {
    links,
    transitions,
    unrecoverable,
    counts,
    campaignStatus:
      outcome.settled && outcome.status !== campaign.status ? outcome.status : null,
  };
}

async function messagesForCampaign(prisma, campaign, recipients) {
  const events = await prisma.activityEvent.findMany({
    where: {
      organisationId: campaign.organisationId,
      entityType: 'Message',
      dedupeKey: { startsWith: `${QUEUE_EVENT_PREFIX}${campaign.id}:` },
    },
    select: { dedupeKey: true, entityId: true },
  });
  const messageIdByRecipient = new Map();
  for (const event of events) {
    const recipientId = event.dedupeKey.slice(`${QUEUE_EVENT_PREFIX}${campaign.id}:`.length);
    if (recipientId && event.entityId) messageIdByRecipient.set(recipientId, event.entityId);
  }
  // A link already on the row wins: it was written by the service, not inferred.
  for (const recipient of recipients) {
    if (recipient.messageId) messageIdByRecipient.set(recipient.id, recipient.messageId);
  }

  const ids = [...new Set(messageIdByRecipient.values())];
  const messages = ids.length
    ? await prisma.message.findMany({
        where: { id: { in: ids }, organisationId: campaign.organisationId },
        select: { id: true, status: true, error: true, externalId: true },
      })
    : [];
  const byId = new Map(messages.map((m) => [m.id, m]));

  const byRecipient = new Map();
  for (const [recipientId, messageId] of messageIdByRecipient) {
    const message = byId.get(messageId);
    if (message) byRecipient.set(recipientId, message);
  }
  return byRecipient;
}

async function apply(prisma, campaign, plan) {
  for (const link of plan.links) {
    await prisma.campaignRecipient.update({
      where: { id: link.recipientId },
      data: { messageId: link.messageId },
    });
  }
  for (const move of plan.transitions) {
    await prisma.campaignRecipient.update({
      where: { id: move.recipientId },
      data: {
        status: move.to,
        ...(move.error ? { lastError: move.error.slice(0, 500) } : {}),
        ...(move.clearSentAt ? { sentAt: null } : {}),
      },
    });
  }
  if (plan.campaignStatus) {
    await prisma.messagingCampaign.update({
      where: { id: campaign.id },
      data: {
        status: plan.campaignStatus,
        finishedAt: campaign.finishedAt ?? new Date(),
      },
    });
  }
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const host = databaseHost();
  console.log(`Database: ${host}`);
  console.log(args.apply ? 'Mode: APPLY — rows will be written.' : 'Mode: dry run — nothing is written.');

  if (args.apply) {
    if (!args.campaignId) {
      throw new Error('--apply needs --campaign <id>: one run corrects one broadcast.');
    }
    const local = host.startsWith('127.0.0.1') || host.startsWith('localhost');
    if (!local && args.host !== host) {
      throw new Error(
        `This is not a local database. To write to it, pass --host ${host} exactly as printed above.`,
      );
    }
  }

  const prisma = new PrismaClient();
  try {
    const campaigns = await prisma.messagingCampaign.findMany({
      where: args.campaignId ? { id: args.campaignId } : {},
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        organisationId: true,
        status: true,
        finishedAt: true,
      },
    });
    if (!campaigns.length) {
      console.log('No campaigns matched.');
      return;
    }

    for (const campaign of campaigns) {
      const recipients = await prisma.campaignRecipient.findMany({
        where: { organisationId: campaign.organisationId, campaignId: campaign.id },
        select: { id: true, status: true, attempts: true, sentAt: true, messageId: true },
      });
      const messageByRecipient = await messagesForCampaign(prisma, campaign, recipients);
      const plan = planCampaign(campaign, recipients, messageByRecipient);

      console.log('');
      console.log(`"${campaign.name}" (${campaign.id}) — ${campaign.status}, ${recipients.length} recipients`);
      console.log(`  message links to restore: ${plan.links.length}`);
      if (plan.transitions.length) {
        const byMove = {};
        for (const move of plan.transitions) {
          const key = `${move.from} -> ${move.to}`;
          byMove[key] ??= { n: 0, error: move.error };
          byMove[key].n += 1;
        }
        for (const [move, detail] of Object.entries(byMove)) {
          console.log(`  ${detail.n} recipients ${move}${detail.error ? `  (${detail.error})` : ''}`);
        }
      } else {
        console.log('  no recipient status is wrong');
      }
      if (plan.unrecoverable.length) {
        console.log(
          `  ${plan.unrecoverable.length} rows say 'sent' with no message on record — left untouched, needs a human`,
        );
      }
      console.log(`  counts after: ${JSON.stringify(plan.counts)}`);
      console.log(
        plan.campaignStatus
          ? `  campaign status: ${campaign.status} -> ${plan.campaignStatus}`
          : `  campaign status unchanged (${campaign.status})`,
      );

      if (args.apply) {
        await apply(prisma, campaign, plan);
        console.log('  applied.');
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
