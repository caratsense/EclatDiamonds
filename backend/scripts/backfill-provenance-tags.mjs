/**
 * Backfill the provenance tags — "Meta Leads", "Walk-in Leads",
 * "Demo Ad Customers" — onto the leads and customers that already earned them.
 *
 * The client's words: "whatever leads or customers came through the Meta should
 * have a tag called Meta leads. The leads which came from walk-in data should be
 * named walk-in lead. Whatever customer came from the demo ad that we ran should
 * be tagged demo ad customers."
 *
 * WHY THERE IS NOTHING TO SELECT. The broadcast audience builder selects on
 * tags and on nothing else, and the live database holds one LeadTag, one
 * PartyTagAssignment and no LeadTagAssignment at all — so picking a tag there
 * correctly matched nobody, which is exactly what she reported. The provenance
 * itself was never missing: it is on `Lead.source`, and for the demo advert it
 * is the ad-routing rule stamped on the conversation. This writes it in the one
 * vocabulary the picker reads.
 *
 * WHAT COUNTS AS WHAT lives in src/crm/provenance-tags.ts and is unit-tested
 * there, so the rule is one statement rather than a copy in a script. This file
 * is the reading, the writing and the report, and nothing else.
 *
 * DEMO-AD CUSTOMERS are the parties behind the conversations the demo advert
 * opened, identified by the routing rule on file (DEMO_RULE_IDS below). The
 * advert is evidence of its own; no `Lead.source` value stands in for it.
 *
 * WHAT IT CANNOT REACH. The Meta tag is read from `Lead.source`, and every
 * automatic path used to file a lead as `whatsapp` whatever the customer had
 * clicked (see src/crm/lead-source.spec.ts). A lead opened before that was
 * fixed therefore says `whatsapp` and is left untagged here, even where the ad
 * ids on its conversation prove it came from Meta. Recovering those is a
 * decision of its own — it means reading provenance from the conversation and
 * overriding what the lead says — and is deliberately not taken in this run.
 *
 * ADDS ONLY. Every write is a createMany with skipDuplicates against the
 * ([leadId, tagId]) and ([partyId, tagId]) uniques, so a tag applied twice is
 * the same tag and a re-run changes nothing. Nothing is deleted and nothing is
 * updated, so a tag somebody put on by hand survives this untouched — including
 * a retired tag, which is left retired and reported rather than switched back on.
 *
 * UNDOING IT. The assignment row IS the record of this run, and it is marked:
 * the API always stamps `assignedById` / `createdById` with the person who
 * applied the tag, so a row of one of these three tags with neither is one of
 * ours and nobody else's. No audit rows are written for that reason — one per
 * assignment would be thousands of rows restating what the assignment says.
 *
 * DRY RUN BY DEFAULT. Writes only with --apply, so the plan can be read on real
 * data before any row changes. --apply also needs --organisation: one run
 * writes to one organisation. On a database that is not on this machine it
 * needs --host as well, typed as the first line of the report prints it, so a
 * DATABASE_URL left over from other work is not written to by mistake.
 *
 *   node scripts/backfill-provenance-tags.mjs                               # report only, every organisation
 *   node scripts/backfill-provenance-tags.mjs --organisation <slug or id>   # report only, one organisation
 *   node scripts/backfill-provenance-tags.mjs --apply --organisation <slug or id>   # write, local database
 *   node scripts/backfill-provenance-tags.mjs --apply --organisation <slug or id> --host <host:port>   # write, hosted database
 *
 * Needs Node 22.18 or newer, which loads the TypeScript import below as it is.
 */
import { PrismaClient } from '@prisma/client';
// The product's own vocabulary rather than a copy of it, so the two cannot
// drift. ponytail: the TypeScript file is imported as it is, which costs a Node
// warning on every run (it had to work out the file is an ES module). That is
// expected, and its advice to change package.json is not to be taken: the
// backend is built as CommonJS. The file holds no decorators and no parameter
// properties on purpose — strip-only mode refuses both.
import {
  DEMO_AD_CUSTOMERS_TAG,
  planProvenanceTags,
  TAGGED_LEAD_SOURCES,
} from '../src/crm/provenance-tags.ts';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const orgFlag = process.argv.indexOf('--organisation');
const ORGANISATION = orgFlag > -1 ? process.argv[orgFlag + 1] : null;
const hostFlag = process.argv.indexOf('--host');
const HOST = hostFlag > -1 ? process.argv[hostFlag + 1] : null;

/**
 * The ad-routing rules the demo advert ran under, which is what marks a
 * conversation as the demo's.
 *
 * Hard-coded rather than taken from a flag: this is a one-off fact about one
 * campaign that has already happened, and a wrong id typed at the prompt would
 * tag customers as having seen an advert they never saw.
 */
const DEMO_RULE_IDS = ['eclat-demo-bandra-ad', 'camp-demo-bandra-3'];

/** Rows per write. One round trip per few thousand, and small enough to watch. */
const BATCH = 500;

/**
 * Where this run is pointed: the connection string Prisma uses, parsed once.
 * It also holds the user and the password, so only its host and its database
 * name are ever printed, and it is never echoed whole, not even in an error.
 */
const db = URL.parse(process.env.DATABASE_URL ?? '');

const listed = (counts) =>
  Object.entries(counts)
    .sort()
    .map(([key, n]) => `${key} ${n}`)
    .join(', ');

/** Write in batches, counting only the rows the database accepted as new. */
async function insert(ids, write) {
  let made = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const { count } = await write(ids.slice(i, i + BATCH));
    made += count;
  }
  return made;
}

async function backfill(organisation) {
  console.log(`== ${organisation.slug} (${organisation.id}) ==\n`);

  const [leads, demoThreads, vocabulary] = await Promise.all([
    prisma.lead.findMany({
      where: { organisationId: organisation.id, source: { in: TAGGED_LEAD_SOURCES } },
      select: { id: true, partyId: true, source: true },
    }),
    prisma.conversation.findMany({
      where: { organisationId: organisation.id, matchedRuleId: { in: DEMO_RULE_IDS } },
      select: { partyId: true, matchedRuleId: true },
    }),
    prisma.leadTag.findMany({
      where: { organisationId: organisation.id },
      select: { id: true, slug: true, name: true, isActive: true },
    }),
  ]);

  const { plans, demoThreadsWithoutCustomer } = planProvenanceTags({ leads, demoThreads });
  const bySlug = new Map(vocabulary.map((row) => [row.slug, row]));
  const demoRules = {};
  for (const thread of demoThreads) {
    demoRules[thread.matchedRuleId] = (demoRules[thread.matchedRuleId] ?? 0) + 1;
  }

  const written = { tags: 0, leads: 0, parties: 0 };
  for (const [index, plan] of plans.entries()) {
    const { tag } = plan;
    let row = bySlug.get(tag.slug) ?? null;
    const existed = row !== null;

    if (!existed && APPLY) {
      // Upserted rather than created: a tag added by hand between the read
      // above and this line is somebody else's row, and is used as it is.
      row = await prisma.leadTag.upsert({
        where: { organisationId_slug: { organisationId: organisation.id, slug: tag.slug } },
        create: {
          organisationId: organisation.id,
          name: tag.name,
          slug: tag.slug,
          colour: tag.colour,
          // After the tenant's own tags, so a vocabulary somebody has already
          // put in order is not reshuffled by this.
          sortOrder: vocabulary.length + index,
        },
        update: {},
        select: { id: true, slug: true, name: true, isActive: true },
      });
    }
    if (!existed) written.tags += 1;

    console.log(`  ${tag.name}`);
    console.log(
      `    tag        ${
        existed
          ? `on file${row.name === tag.name ? '' : ` as "${row.name}"`}${
              row.isActive ? '' : ' — RETIRED, so it is not in the broadcast picker'
            }`
          : APPLY
            ? 'created'
            : `would be created (${tag.colour})`
      }`,
    );

    // Everything already on record comes off the plan before anything is
    // written, so the counts say how many rows this run is responsible for and
    // not one more. A tag that does not exist yet has no assignments at all.
    let leadIds = plan.leadIds;
    let partyIds = plan.partyIds;
    let leadsAlready = 0;
    let partiesAlready = 0;
    if (row) {
      const [onLeads, onParties] = await Promise.all([
        prisma.leadTagAssignment.findMany({
          where: { tagId: row.id },
          select: { leadId: true },
        }),
        prisma.partyTagAssignment.findMany({
          where: { tagId: row.id },
          select: { partyId: true },
        }),
      ]);
      const taggedLeads = new Set(onLeads.map((a) => a.leadId));
      const taggedParties = new Set(onParties.map((a) => a.partyId));
      leadIds = plan.leadIds.filter((id) => !taggedLeads.has(id));
      partyIds = plan.partyIds.filter((id) => !taggedParties.has(id));
      leadsAlready = plan.leadIds.length - leadIds.length;
      partiesAlready = plan.partyIds.length - partyIds.length;
    }

    let madeLeads = 0;
    let madeParties = 0;
    if (APPLY) {
      madeLeads = await insert(leadIds, (batch) =>
        prisma.leadTagAssignment.createMany({
          data: batch.map((leadId) => ({ organisationId: organisation.id, leadId, tagId: row.id })),
          skipDuplicates: true,
        }),
      );
      madeParties = await insert(partyIds, (batch) =>
        prisma.partyTagAssignment.createMany({
          data: batch.map((partyId) => ({
            organisationId: organisation.id,
            partyId,
            tagId: row.id,
          })),
          skipDuplicates: true,
        }),
      );
      written.leads += madeLeads;
      written.parties += madeParties;
    }

    const line = (what, wanted, made, already) =>
      console.log(
        `    ${what.padEnd(10)} ${APPLY ? `${made} tagged` : `${wanted} to tag`}, ` +
          `${already} already tagged` +
          (APPLY && made !== wanted ? `, ${wanted - made} tagged by somebody while this ran` : ''),
      );
    line('leads', leadIds.length, madeLeads, leadsAlready);
    line('customers', partyIds.length, madeParties, partiesAlready);
    if (Object.keys(plan.sources).length) console.log(`    from       ${listed(plan.sources)}`);
    // Printed rather than passed over: a broadcast sends to CUSTOMERS, so a
    // lead with no customer record is a person this tag cannot reach yet.
    if (plan.leadsWithoutCustomer) {
      console.log(`    left out   ${plan.leadsWithoutCustomer} lead(s) with no customer record`);
    }
    if (tag.slug === DEMO_AD_CUSTOMERS_TAG.slug) {
      console.log(`    threads    ${listed(demoRules) || 'none on file'}`);
      if (demoThreadsWithoutCustomer) {
        console.log(`    left out   ${demoThreadsWithoutCustomer} demo thread(s) with no customer resolved`);
      }
    }
    console.log();
  }

  return written;
}

async function main() {
  if (!db) throw new Error('DATABASE_URL is missing or is not a URL.');
  console.log(`Database: ${decodeURIComponent(db.pathname.slice(1))} on ${db.host}`);

  if (orgFlag > -1 && !ORGANISATION) throw new Error('--organisation needs a slug or an id.');
  if (APPLY && !ORGANISATION) {
    throw new Error('--apply needs --organisation <slug or id>: one run writes to one organisation.');
  }
  // Before anything is read: a hosted database is written to only by somebody
  // who has typed its host, not by whoever still has its URL in their shell.
  const onThisMachine = ['localhost', '127.0.0.1', '[::1]'].includes(db.hostname);
  if (APPLY && !onThisMachine && HOST !== db.host) {
    throw new Error(`--apply on a database that is not on this machine needs --host ${db.host}, typed out.`);
  }

  const organisations = await prisma.organisation.findMany({
    where: ORGANISATION ? { OR: [{ id: ORGANISATION }, { slug: ORGANISATION }] } : {},
    select: { id: true, slug: true },
    orderBy: { slug: 'asc' },
  });
  if (ORGANISATION && organisations.length !== 1) {
    throw new Error(
      `"${ORGANISATION}" names ${organisations.length} organisations here. It has to name exactly one.`,
    );
  }
  console.log(
    `Organisation: ${ORGANISATION ? `${organisations[0].slug} (${organisations[0].id})` : 'all of them'}`,
  );
  console.log(`Demo-ad rules: ${DEMO_RULE_IDS.join(', ')}\n`);

  const total = { tags: 0, leads: 0, parties: 0 };
  for (const organisation of organisations) {
    const written = await backfill(organisation);
    for (const key of Object.keys(total)) total[key] += written[key];
  }

  console.log(
    APPLY
      ? `Written: ${total.tags} tag(s) created, ${total.leads} lead assignment(s), ${total.parties} customer assignment(s).`
      : `DRY RUN - nothing written. Would create ${total.tags} tag(s) and the assignments counted above.`,
  );
  console.log(
    APPLY
      ? 'Re-running changes nothing: an assignment is unique per (target, tag) and this only ever adds.'
      : 'Re-run with --apply --organisation <slug or id> once the plan above looks right.',
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
