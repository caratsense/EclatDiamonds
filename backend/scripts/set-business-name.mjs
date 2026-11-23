/**
 * What a tenant is called — in the database, which is now what customers read.
 *
 * Until the outbound signature changed, `Organisation.name` was an internal
 * label: staff saw the sidebar, which reads a hardcoded TENANT_NAME in the
 * frontend, so nobody noticed the row still said "Eclat" after the business
 * became Nibhana. Then every WhatsApp reply started being signed from this
 * column, and a stale value stopped being cosmetic — it would have gone out on
 * the top of every message to every customer, under a brand the business has
 * retired.
 *
 * Sets BOTH, deliberately:
 *   Organisation.name                    — the registered row
 *   settings.branding.displayName        — what the tenant calls itself, which
 *                                          wins over the row wherever it is read
 *
 * This is the in-app name only. It does NOT touch the WhatsApp Business profile:
 * the display name customers see at the top of the chat, the legal business
 * name and the business type all live in Meta Business Manager and are not
 * reachable from this codebase. See the handover notes for the order those must
 * be done in.
 *
 *   node scripts/set-business-name.mjs --organisation <slug|id> --name "Nibhana"
 *   node scripts/set-business-name.mjs --organisation <slug|id> --name "Nibhana" --apply
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};
const APPLY = process.argv.includes('--apply');
const ORG = arg('organisation');
const NAME = arg('name');

if (!ORG) throw new Error('--organisation <slug or id> is required.');
if (!NAME || !NAME.trim()) throw new Error('--name "<business name>" is required.');
const name = NAME.trim();

/*
 * A name that goes on a customer's phone is worth one sanity check. Not a
 * validation rule — a jeweller may legitimately be called anything — but these
 * two have a real cost: a 60-character legal name reads as spam above every
 * message, and an asterisk would break the bold markup the signature uses.
 */
if (name.length > 40) {
  console.log(`WARNING: "${name}" is ${name.length} characters and will head every WhatsApp message.`);
}
if (name.includes('*')) {
  throw new Error('A business name cannot contain *, which is WhatsApp\'s bold marker.');
}

const org = await prisma.organisation.findFirst({
  where: { OR: [{ id: ORG }, { slug: ORG }] },
  select: { id: true, slug: true, name: true, settings: true },
});
if (!org) throw new Error(`No organisation "${ORG}".`);

const settings = org.settings ?? {};
const branding = settings.branding ?? {};
console.log(`organisation ${org.slug}`);
console.log(`  name                      : ${JSON.stringify(org.name)}  ->  ${JSON.stringify(name)}`);
console.log(`  branding.displayName      : ${JSON.stringify(branding.displayName ?? null)}  ->  ${JSON.stringify(name)}`);
console.log('');
console.log('  every WhatsApp reply will be signed:', JSON.stringify(`*${name}*`));

/*
 * How many messages already carry the OLD name, so the number is seen before
 * the switch rather than discovered in a thread afterwards. They stay readable:
 * the reader strips a list of candidate names, and the previous one is still on
 * the row that was signed with it.
 */
const signedOld = await prisma.message.count({
  where: { organisationId: org.id, direction: 'outbound', body: { startsWith: `*${org.name}*` } },
});
console.log(`  messages already signed "${org.name}": ${signedOld} (left as sent; readers strip both)`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply.');
} else {
  await prisma.organisation.update({
    where: { id: org.id },
    data: { name, settings: { ...settings, branding: { ...branding, displayName: name } } },
  });
  console.log('\nSet. The next reply leaves under the new name.');
}

await prisma.$disconnect();
