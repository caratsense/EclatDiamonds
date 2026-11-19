/**
 * Declare what a tenant treats as permission to send marketing.
 *
 * `implied` means everyone on the customer list may be messaged until they
 * revoke — the Nibhana owner's decision, in their words: "every customer which
 * comes to the CRM already comes with marketing consent, until they explicitly
 * tell us". `explicit` is the default and the stricter reading: a recorded
 * grant, and silence is not one.
 *
 * A revocation is refused under either basis. This setting decides what
 * SILENCE means, never what a refusal means — see
 * src/omnichannel/marketing-consent-basis.spec.ts.
 *
 * Deliberately a script and not a migration. Turning permissive marketing on
 * for a business is somebody's decision, recorded against their name, not
 * something a deploy does quietly to every tenant that happens to upgrade.
 *
 *   node scripts/set-marketing-consent-basis.mjs --organisation <slug|id>
 *   node scripts/set-marketing-consent-basis.mjs --organisation <slug|id> --basis implied --apply
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};
const APPLY = process.argv.includes('--apply');
const ORG = arg('organisation');
const BASIS = arg('basis') ?? 'implied';

if (!ORG) throw new Error('--organisation <slug or id> is required.');
if (!['implied', 'explicit'].includes(BASIS)) {
  throw new Error(`--basis must be implied or explicit, not "${BASIS}".`);
}

const org = await prisma.organisation.findFirst({
  where: { OR: [{ id: ORG }, { slug: ORG }] },
  select: { id: true, slug: true, name: true, settings: true },
});
if (!org) throw new Error(`No organisation "${ORG}".`);

const settings = (org.settings ?? {});
const before = settings.marketingConsentBasis ?? '(unset — treated as explicit)';
console.log(`${org.name} (${org.slug})`);
console.log(`  marketing consent basis: ${before}  ->  ${BASIS}`);

/*
 * What this actually changes, counted, so the number is seen before the switch
 * rather than discovered in a send report afterwards.
 */
const customers = await prisma.party.count({
  where: { organisationId: org.id, archivedAt: null, types: { has: 'customer' } },
});
const revoked = await prisma.activityEvent.count({
  where: { organisationId: org.id, type: 'consent.revoked' },
});
console.log(`  customers on the list    : ${customers}`);
console.log(`  recorded opt-outs        : ${revoked} (refused under either basis)`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to set it.');
} else {
  await prisma.organisation.update({
    where: { id: org.id },
    data: { settings: { ...settings, marketingConsentBasis: BASIS } },
  });
  console.log('\nSet. Marketing sends now read this basis at queue time and again at delivery.');
}

await prisma.$disconnect();
