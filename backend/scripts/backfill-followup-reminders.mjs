/**
 * Give the follow-ups already in the database the instant somebody is told.
 *
 * `dueDate` is the day the CUSTOMER is owed a call; `reminderAt` is the moment
 * the EMPLOYEE hears about it, and it is the only field the reminder sweep
 * looks at. Every automatic follow-up was written with the first and not the
 * second, so 11,622 of them sat due and announced themselves to nobody —
 * exactly one row in the whole database had a reminder on it, typed by hand
 * from a check-in screen.
 *
 * The code that writes new ones is fixed. This is for the ones already there.
 *
 * ONLY OPEN FOLLOW-UPS. A completed one needs no reminder and must not get a
 * notification months late, and a row that already has a reminder is left
 * exactly as it is — including one somebody set by hand, which this must never
 * overwrite.
 *
 * A due day in the PAST does not fire retroactively: it is set to the next
 * sweep, so an overdue follow-up surfaces once, now, rather than eleven
 * thousand notifications for days that have already gone.
 *
 *   node scripts/backfill-followup-reminders.mjs
 *   node scripts/backfill-followup-reminders.mjs --apply
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

/** Defaults mirrored from FollowUpRemindersService.settings. */
const DEFAULT_TIME_LOCAL = '10:00';
const DEFAULT_DAYS_BEFORE = 0;
const DEFAULT_TZ = 'Asia/Kolkata';
const DAY_MS = 86_400_000;

/**
 * The UTC instant of a local wall-clock time on a given day, in `tz`.
 *
 * Derived by asking the zone what its offset is near that moment rather than
 * by assuming one, so a tenant in a zone that shifts is not half an hour out
 * for part of the year.
 */
function instantFromLocal(dueDay, minutes, tz) {
  const guess = new Date(dueDay.getTime() + minutes * 60_000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(guess);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offset = asUtc - guess.getTime();
  return new Date(guess.getTime() - offset);
}

const orgs = await prisma.organisation.findMany({ select: { id: true, slug: true, settings: true } });
const stores = await prisma.store.findMany({ select: { id: true, timezone: true, organisationId: true } });
const tzByStore = new Map(stores.map((s) => [s.id, s.timezone || DEFAULT_TZ]));
const orgByStore = new Map(stores.map((s) => [s.id, s.organisationId]));
const settingsByOrg = new Map(
  orgs.map((o) => {
    const r = o.settings?.crmFollowUpReminders ?? {};
    return [o.id, {
      timeLocal: typeof r.defaultTimeLocal === 'string' ? r.defaultTimeLocal : DEFAULT_TIME_LOCAL,
      daysBefore: Number.isInteger(r.defaultDaysBefore) ? r.defaultDaysBefore : DEFAULT_DAYS_BEFORE,
    }];
  }),
);

const open = await prisma.leadFollowUp.findMany({
  where: { done: false, reminderAt: null },
  select: { id: true, storeId: true, dueDate: true },
  orderBy: { dueDate: 'asc' },
});

const total = await prisma.leadFollowUp.count();
const alreadySet = await prisma.leadFollowUp.count({ where: { reminderAt: { not: null } } });
console.log(`follow-ups in total          : ${total}`);
console.log(`already carry a reminder     : ${alreadySet}  (left untouched)`);
console.log(`open, with no reminder       : ${open.length}`);

const now = new Date();
const planned = [];
let overdue = 0;
for (const f of open) {
  const tz = tzByStore.get(f.storeId) ?? DEFAULT_TZ;
  const orgId = orgByStore.get(f.storeId);
  const s = settingsByOrg.get(orgId) ?? { timeLocal: DEFAULT_TIME_LOCAL, daysBefore: DEFAULT_DAYS_BEFORE };
  const [hh, mm] = s.timeLocal.split(':').map(Number);
  const day = new Date(f.dueDate.getTime() - s.daysBefore * DAY_MS);
  let at = instantFromLocal(day, hh * 60 + mm, tz);
  // Already past: surface once on the next sweep rather than pretend it fired
  // on a day that has gone.
  if (at.getTime() < now.getTime()) { at = now; overdue += 1; }
  planned.push({ id: f.id, reminderAt: at });
}

console.log(`  of those, already overdue  : ${overdue}  (set to the next sweep, so each surfaces once)`);
console.log(`  future, set to their own day: ${planned.length - overdue}`);

if (!planned.length) {
  console.log('\nNothing to backfill.');
} else if (!APPLY) {
  const sample = planned.slice(0, 3);
  console.log('\nsample:');
  for (const p of sample) console.log(`  ${p.id} -> ${p.reminderAt.toISOString()}`);
  console.log(`\nDRY RUN — nothing written. Re-run with --apply.`);
} else {
  let done = 0;
  for (let i = 0; i < planned.length; i += 200) {
    const chunk = planned.slice(i, i + 200);
    await prisma.$transaction(
      chunk.map((p) =>
        // `reminderAt: null` in the condition so a reminder somebody set while
        // this ran is never overwritten.
        prisma.leadFollowUp.updateMany({
          where: { id: p.id, reminderAt: null, done: false },
          data: { reminderAt: p.reminderAt },
        }),
      ),
    );
    done += chunk.length;
    if (done % 2000 === 0 || done === planned.length) console.log(`  ${done}/${planned.length}`);
  }
  console.log(`\nSet a reminder on ${done} follow-ups.`);
}

await prisma.$disconnect();
