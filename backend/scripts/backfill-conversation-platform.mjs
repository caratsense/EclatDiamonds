/**
 * Backfill `Conversation.sourcePlatform` from referrals already on record.
 *
 * One advert runs on Instagram and on Facebook at once, and both CTAs open
 * WhatsApp — so the thread alone cannot say which surface the customer tapped.
 * The referral can: Meta sends `source_url`, pointing back at the post, and its
 * host is the same signal WhatsApp uses to print "Instagram ad" above the chat.
 *
 * New conversations capture it at creation. This recovers it for the ones
 * created before that shipped, reading the referral that was stored verbatim at
 * the time — so nothing here is inferred or guessed, only read late.
 *
 * DRY RUN BY DEFAULT. Writes only with --apply, so the mapping can be inspected
 * on real data before any row changes.
 *
 *   node scripts/backfill-conversation-platform.mjs            # report only
 *   node scripts/backfill-conversation-platform.mjs --apply    # write
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

/** Same rule as `platformFromSourceUrl` in meta-referral.ts. Kept in step by hand. */
function platformFromSourceUrl(sourceUrl) {
  if (!sourceUrl) return null;
  let host;
  try {
    host = new URL(sourceUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.includes('instagram') || host === 'ig.me') return 'instagram';
  if (host.includes('facebook') || host === 'fb.me' || host === 'fb.com') return 'facebook';
  if (host.includes('messenger') || host === 'm.me') return 'messenger';
  return null;
}

/** The referral's source_url, wherever it was filed. */
function sourceUrlFrom(touch) {
  const meta = touch?.metadata;
  if (!meta || typeof meta !== 'object') return null;
  if (typeof meta.sourceUrl === 'string') return meta.sourceUrl;
  const raw = meta.providerReferral;
  if (raw && typeof raw === 'object' && typeof raw.source_url === 'string') return raw.source_url;
  return null;
}

async function main() {
  const rows = await prisma.conversation.findMany({
    where: { sourceAdId: { not: null }, sourcePlatform: null },
    select: { id: true, organisationId: true, sourceAdId: true, partyId: true },
  });

  console.log(`${rows.length} ad conversation(s) with no platform recorded.\n`);
  if (!rows.length) return;

  const counts = { instagram: 0, facebook: 0, messenger: 0, unreadable: 0, noTouch: 0 };

  for (const row of rows) {
    // The touch carries the referral. Matched on the ad id as well as the
    // conversation, so a party with several ad clicks cannot lend this thread
    // the wrong one.
    const touch = await prisma.attributionTouch.findFirst({
      where: {
        organisationId: row.organisationId,
        externalAdId: row.sourceAdId,
        ...(row.partyId ? { partyId: row.partyId } : {}),
      },
      orderBy: { occurredAt: 'asc' },
      select: { metadata: true, occurredAt: true },
    });

    if (!touch) {
      counts.noTouch += 1;
      console.log(`  ${row.id}  ad ${row.sourceAdId}  -> no attribution touch on file`);
      continue;
    }

    const url = sourceUrlFrom(touch);
    const platform = platformFromSourceUrl(url);

    if (!platform) {
      counts.unreadable += 1;
      console.log(`  ${row.id}  ad ${row.sourceAdId}  -> UNREADABLE  source_url=${url ?? '<absent>'}`);
      continue;
    }

    counts[platform] += 1;
    console.log(`  ${row.id}  ad ${row.sourceAdId}  -> ${platform.toUpperCase()}  (${url})`);

    if (APPLY) {
      await prisma.conversation.update({
        where: { id: row.id },
        data: { sourcePlatform: platform },
      });
    }
  }

  console.log(
    `\ninstagram ${counts.instagram} · facebook ${counts.facebook} · messenger ${counts.messenger}` +
      ` · unreadable ${counts.unreadable} · no touch ${counts.noTouch}`,
  );
  console.log(
    APPLY
      ? '\nWritten. Rows left unreadable keep sourcePlatform NULL and show the plain "Ad Lead" chip,\nwhich is the honest outcome - the referral genuinely did not say.'
      : '\nDRY RUN - nothing written. Re-run with --apply once the mapping above looks right.',
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
