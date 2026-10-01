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
 * WHICH TOUCH IS A THREAD'S OWN. The app files an ad touch under the customer
 * while the thread has no branch and under the lead once it has one, and moves
 * it when the thread is routed later or two customers are merged. So the
 * customer is not the link. What never changes is what the app stamped on the
 * touch when it recorded the tap: the conversation id (in `metadata`), the ad
 * id and the click id. A touch is matched on those three, and where the tap
 * carried no click id it must also have been recorded as the thread was
 * created. A thread whose own touch cannot be told from another tap's is left
 * alone, with the reason printed, rather than given the other tap's platform.
 *
 * DRY RUN BY DEFAULT. Writes only with --apply, so the mapping can be inspected
 * on real data before any row changes. --apply also needs --organisation: one
 * run writes to one organisation.
 *
 *   node scripts/backfill-conversation-platform.mjs                               # report only, every organisation
 *   node scripts/backfill-conversation-platform.mjs --organisation <slug or id>   # report only, one organisation
 *   node scripts/backfill-conversation-platform.mjs --apply --organisation <slug or id>   # write
 *
 * Needs Node 22.18 or newer, which loads the TypeScript import below as it is.
 */
import { PrismaClient } from '@prisma/client';
// The app's own host rule rather than a copy of it, so the two cannot drift.
// ponytail: the TypeScript file is imported as it is, which costs a Node
// warning on every run (it had to work out the file is an ES module). That is
// expected, and its advice to change package.json is not to be taken: the
// backend is built as CommonJS. Import the built rule from dist/ if the warning
// or the Node version ever gets in the way.
import { platformFromSourceUrl } from '../src/integrations/meta-referral.ts';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const orgFlag = process.argv.indexOf('--organisation');
const ORGANISATION = orgFlag > -1 ? process.argv[orgFlag + 1] : null;

/**
 * How soon after a thread is created its opening tap's touch must have been
 * recorded. The app writes both in the same request, so they are seconds apart
 * at most; a second tap on the same advert needs the customer to go back to it
 * and write in again.
 *
 * ponytail: a minute on the clock stands in for proof, and only where the tap
 * carried no click id. A touch the app recorded later than that is left alone,
 * which is the safe side. If that leaves real threads empty, read the referral
 * from the thread's first Message.payload instead, where it is kept verbatim.
 */
const OPENING_MS = 60_000;

/**
 * Where this run is pointed: the connection string Prisma uses, parsed once.
 * It also holds the user and the password, so only its host and its database
 * name are ever printed, and it is never echoed whole, not even in an error.
 */
const db = URL.parse(process.env.DATABASE_URL ?? '');

/** The referral's source_url, wherever it was filed. */
function sourceUrlFrom(touch) {
  const meta = touch?.metadata;
  if (!meta || typeof meta !== 'object') return null;
  if (typeof meta.sourceUrl === 'string') return meta.sourceUrl;
  const raw = meta.providerReferral;
  if (raw && typeof raw === 'object' && typeof raw.source_url === 'string') return raw.source_url;
  return null;
}

/**
 * Only the host is ever printed. It is all the rule reads, and the rest of a
 * source_url can carry anything: a wa.me link carries a phone number.
 */
function hostOf(sourceUrl) {
  try {
    return new URL(sourceUrl).hostname;
  } catch {
    return sourceUrl ? 'not a URL' : 'absent';
  }
}

const tally = (counts, key) => {
  counts[key] = (counts[key] ?? 0) + 1;
};
const listed = (counts) => Object.entries(counts).sort().map(([key, n]) => `${key} ${n}`).join(', ');
const total = (counts) => Object.values(counts).reduce((sum, n) => sum + n, 0);

async function main() {
  if (!db) throw new Error('DATABASE_URL is missing or is not a URL.');
  console.log(`Database: ${decodeURIComponent(db.pathname.slice(1))} on ${db.host}`);

  if (orgFlag > -1 && !ORGANISATION) throw new Error('--organisation needs a slug or an id.');
  if (APPLY && !ORGANISATION) {
    throw new Error('--apply needs --organisation <slug or id>: one run writes to one organisation.');
  }

  let organisation = null;
  if (ORGANISATION) {
    const named = await prisma.organisation.findMany({
      where: { OR: [{ id: ORGANISATION }, { slug: ORGANISATION }] },
      select: { id: true, slug: true },
    });
    if (named.length !== 1) {
      throw new Error(`"${ORGANISATION}" names ${named.length} organisations here. It has to name exactly one.`);
    }
    organisation = named[0];
  }
  console.log(`Organisation: ${organisation ? `${organisation.slug} (${organisation.id})` : 'all of them'}\n`);

  const rows = await prisma.conversation.findMany({
    where: {
      sourceAdId: { not: null },
      sourcePlatform: null,
      ...(organisation ? { organisationId: organisation.id } : {}),
    },
    select: {
      id: true,
      organisationId: true,
      sourceAdId: true,
      sourceClickId: true,
      createdAt: true,
      organisation: { select: { slug: true } },
    },
    orderBy: [{ organisationId: 'asc' }, { createdAt: 'asc' }],
  });

  console.log(`${rows.length} ad conversation(s) with no platform recorded.\n`);
  if (!rows.length) return;

  const written = {};
  const leftAlone = {};

  for (const row of rows) {
    const say = (outcome) =>
      console.log(`  ${row.organisation.slug}  ${row.id}  ad ${row.sourceAdId}  -> ${outcome}`);

    // ponytail: one lookup per conversation, and nothing indexes the id inside
    // `metadata`, so each one reads through the organisation's touches. Fine
    // for a one-off over a tenant's ad threads; fetch the organisation's ad
    // touches once and group them by conversation if it is ever slow.
    const touches = await prisma.attributionTouch.findMany({
      where: {
        organisationId: row.organisationId,
        metadata: { path: ['conversationId'], equals: row.id },
        externalAdId: row.sourceAdId,
        // The click id is Meta's own name for one tap, so a later tap on this
        // thread never matches. Where the opening tap carried none, the same
        // advert tapped again looks identical, and only the moment tells them
        // apart: the opening tap's touch was recorded as the thread was created.
        clickId: row.sourceClickId,
        ...(row.sourceClickId
          ? {}
          : { createdAt: { lt: new Date(row.createdAt.getTime() + OPENING_MS) } }),
      },
      select: { metadata: true },
    });

    if (!touches.length) {
      tally(leftAlone, 'no touch');
      say('left alone: no touch on file for the tap that opened it');
      continue;
    }

    const urls = touches.map(sourceUrlFrom);
    const platforms = [...new Set(urls.map((url) => platformFromSourceUrl(url)))];
    const hosts = [...new Set(urls.map(hostOf))].join(', ');

    // Several touches fit only when nothing on record separates them. If they
    // also disagree, writing either would be a guess.
    if (platforms.length > 1) {
      tally(leftAlone, 'ambiguous');
      say(`left alone: ${touches.length} touches fit and they disagree (${hosts})`);
      continue;
    }

    const [platform] = platforms;
    if (!platform) {
      tally(leftAlone, 'unreadable');
      say(`left alone: its source_url names no platform (${hosts})`);
      continue;
    }

    if (APPLY) {
      // Only while it is still empty: a platform set since the read above is
      // somebody else's answer and is not overwritten. The line is printed
      // after the write, so a line that says written was written.
      const { count } = await prisma.conversation.updateMany({
        where: { id: row.id, sourcePlatform: null },
        data: { sourcePlatform: platform },
      });
      if (!count) {
        tally(leftAlone, 'set meanwhile');
        say('left alone: a platform was set while this ran');
        continue;
      }
    }

    tally(written, platform);
    say(`${platform.toUpperCase()} (${hosts})${APPLY ? ' written' : ''}`);
  }

  const done = total(written);
  const detail = (counts) => (total(counts) ? `: ${listed(counts)}` : '');
  console.log(
    `\n${APPLY ? 'Written' : 'DRY RUN - nothing written. Would write'} ${done} of ${rows.length}${detail(written)}.`,
  );
  console.log(`Left alone ${rows.length - done}${detail(leftAlone)}.`);
  // The closing lines claim only what this run did. A thread left alone is not
  // always still empty (its platform may have been set meanwhile), and its
  // platform is not always unknowable: only the touch was read here, and the
  // referral is also kept on the thread's first message.
  console.log(
    APPLY
      ? 'Conversations left alone were not written by this run. The reason for each is on its line above.\nThose still without a platform show the plain "Ad Lead" chip.'
      : 'Re-run with --apply --organisation <slug or id> once the mapping above looks right.',
  );
}

main()
  .catch((err) => {
    // Prisma names the database user when a login is refused, so the user and
    // the password are struck out of whatever is printed here.
    const why = [db?.username, db?.password]
      .filter(Boolean)
      .reduce((text, secret) => text.replaceAll(decodeURIComponent(secret), '***'), String(err?.message ?? err));
    console.error(`Stopped: ${why}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
