/**
 * Put the "Gati" tag on every customer the ERP has already sent.
 *
 * The sync tags each party as it upserts it, so new and changed customers
 * arrive tagged from here on. The party feed is watermarked, though, which
 * means the eleven hundred customers already pulled would never be re-pushed
 * and would never be tagged — the directory would show provenance for whoever
 * happened to change next and for nobody else.
 *
 * Idempotent: `skipDuplicates` makes a second run a no-op rather than a second
 * row. Safe to run at any time, including while the sync is running.
 *
 *   node scripts/tag-gati-customers.mjs
 *   node scripts/tag-gati-customers.mjs --apply
 */
if (process.env.DATABASE_PUBLIC_URL && /\.railway\.internal/.test(process.env.DATABASE_URL ?? '')) {
  const u = process.env.DATABASE_PUBLIC_URL;
  process.env.DATABASE_URL = u + (u.includes('?') ? '&' : '?') + 'sslmode=require&connect_timeout=30';
}

const { PrismaClient } = await import('@prisma/client');

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const TAG_NAME = 'Gati';
/** Must match `tagSlug` in crm/lead-tags.service.ts. */
const slug = TAG_NAME.trim().toLowerCase().replace(/\s+/g, ' ');

const orgs = await prisma.organisation.findMany({ select: { id: true, name: true } });

for (const org of orgs) {
  // A customer from the ERP is one carrying its id. The same rule the stock
  // and ledger code uses for "this came from Gati".
  const parties = await prisma.party.findMany({
    where: { organisationId: org.id, legacyId: { not: null } },
    select: { id: true },
  });
  if (!parties.length) continue;

  let tag = await prisma.leadTag.findFirst({
    where: { organisationId: org.id, slug },
    select: { id: true, name: true },
  });

  const already = tag
    ? await prisma.partyTagAssignment.count({
        where: { organisationId: org.id, tagId: tag.id },
      })
    : 0;

  console.log(`${org.name}: ${parties.length} customers from Gati, ${already} already tagged`);
  if (!APPLY) continue;

  if (!tag) {
    tag = await prisma.leadTag.create({
      data: { organisationId: org.id, name: TAG_NAME, slug, colour: 'muted' },
      select: { id: true, name: true },
    });
    console.log(`  created the "${tag.name}" tag`);
  }

  let written = 0;
  for (let i = 0; i < parties.length; i += 500) {
    const batch = parties.slice(i, i + 500);
    const res = await prisma.partyTagAssignment.createMany({
      data: batch.map((p) => ({ organisationId: org.id, partyId: p.id, tagId: tag.id })),
      skipDuplicates: true,
    });
    written += res.count;
  }
  console.log(`  tagged ${written} customers`);
}

if (!APPLY) console.log('\nDRY RUN — nothing written. Re-run with --apply.');

await prisma.$disconnect();
