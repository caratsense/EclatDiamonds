/**
 * The three quick replies that used to be hardcoded, as editable data.
 *
 * Until now the chip row in Conversations was three JSX buttons with their
 * wording compiled in — "Confirm Saturday Visit", "Store Location", "IGI
 * Certificate Info". Nobody at the business could change a word of them, and
 * they vanished entirely once WhatsApp's 24-hour window closed, which is the
 * one moment a shortcut is most useful.
 *
 * They are rows now. This carries the existing three across so the floor staff
 * who use them every day do not lose them on the deploy that makes them
 * editable — and from here she can reword, reorder or delete any of them.
 *
 * Idempotent on (organisation, label): re-running updates nothing it did not
 * create and never duplicates. It also does NOT overwrite wording somebody has
 * since edited — the point of this feature is that her words win over ours.
 *
 *   node scripts/seed-quick-replies.mjs --organisation <slug|id>
 *   node scripts/seed-quick-replies.mjs --organisation <slug|id> --apply
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};
const APPLY = process.argv.includes('--apply');
const ORG = arg('organisation');
if (!ORG) throw new Error('--organisation <slug or id> is required.');

/*
 * The wording is the wording that was on screen, with the hardcoded customer
 * name and branch turned into the placeholders the new feature substitutes.
 * Deliberately not "improved" on the way across: changing what staff send while
 * moving where it is stored would make any complaint afterwards impossible to
 * attribute.
 */
const SEED = [
  {
    label: 'Confirm Saturday Visit',
    kind: 'free_text',
    body:
      'Hello {customer}! Would you like us to reserve a 0.50 ct solitaire ring for your visit this Saturday?',
    sortOrder: 0,
  },
  {
    label: 'Store Location',
    kind: 'free_text',
    body:
      'Our {branch} showroom is open 10:30 AM to 8:30 PM. Shall I send you the address?',
    sortOrder: 1,
  },
  {
    label: 'IGI Certificate Info',
    kind: 'free_text',
    body:
      'All solitaires come with certified IGI laser-inscribed documentation and lifetime buyback guarantee.',
    sortOrder: 2,
  },
];

const org = await prisma.organisation.findFirst({
  where: { OR: [{ id: ORG }, { slug: ORG }] },
  select: { id: true, slug: true, name: true },
});
if (!org) throw new Error(`No organisation "${ORG}".`);

const existing = await prisma.quickReply.findMany({
  where: { organisationId: org.id },
  select: { id: true, label: true },
});
const have = new Set(existing.map((r) => r.label));
const missing = SEED.filter((r) => !have.has(r.label));

console.log(`${org.name} (${org.slug})`);
console.log(`  quick replies already there : ${existing.length}`);
console.log(`  of the original three, missing: ${missing.length}`);
for (const r of missing) console.log(`    + ${r.label}`);

/*
 * Said out loud, because it is the thing somebody will otherwise ask about: a
 * free-text reply cannot be sent once the 24-hour window has closed. The three
 * being carried across are all free text, which is what they were. A reply that
 * works after the window has to name an approved template, and that is a
 * decision about which template — not one this script should make for her.
 */
console.log('\n  All three are free text, as they were. They appear while the 24-hour');
console.log('  window is open. To have one that still works after it closes, add a');
console.log('  template-backed reply on the Quick replies screen.');

if (!missing.length) {
  console.log('\nNothing to add.');
} else if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply.');
} else {
  await prisma.quickReply.createMany({
    data: missing.map((r) => ({ ...r, organisationId: org.id })),
  });
  console.log(`\nAdded ${missing.length}. They are editable on the Quick replies screen.`);
}

await prisma.$disconnect();
