import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/**
 * The one safe way to change `Organisation.settings`.
 *
 * ## The bug this replaces
 *
 * `settings` is a single JSONB column shared by unrelated features: branding,
 * the industry feature profile, the CRM assistant's switches, the qualification
 * policy, ad-set routing rules. Three services each owned one key and each
 * updated it the same way — read the whole column, spread it, write the whole
 * column back:
 *
 *     const org = await prisma.organisation.findUnique(...);      // READ
 *     const merged = { ...org.settings, crmAdSetRules: rules };   // MODIFY
 *     await prisma.organisation.update({ data: { settings: merged } });  // WRITE
 *
 * Sequentially that is correct, and each of those call sites had a comment
 * explaining that the spread was there precisely so as not to clobber a
 * neighbour. Concurrently it is a lost update: the read and the write are two
 * statements, so whoever writes second restores their own stale snapshot of
 * every key they do not own. Turning the AI assistant on could silently delete
 * a tenant's lead-routing rules — and nothing would report an error, because
 * both writes succeeded.
 *
 * ## Why a row lock rather than a merge in SQL
 *
 * `settings || '{...}'::jsonb` in a single UPDATE would be atomic and shorter,
 * and it fixes two of the three call sites. It cannot fix the third: the
 * qualification policy computes `version: current.version + 1`, which has to be
 * read before it can be written, so a blind merge lets two savers both mint the
 * same version number — and that version is what tells an old assessment which
 * rules produced it.
 *
 * Taking the row lock first makes the read-modify-write genuinely serial, so one
 * helper covers every case including the counter, with no retry loop and no
 * error class for callers to handle: the second writer simply waits its turn.
 * `JobsService.claim` already uses raw `FOR UPDATE` in this codebase, so the
 * idiom is not new here.
 */

/** The settings bag, as every caller treats it. */
export type OrgSettings = Record<string, unknown>;

type Tx = Prisma.TransactionClient;

/**
 * Read-modify-write `Organisation.settings` under a row lock.
 *
 * `mutate` receives the CURRENT settings — already locked, so what it sees is
 * what it will be writing against — and returns the complete new object. It runs
 * inside the transaction, so keep it pure and quick: no HTTP, no other tables.
 *
 * Pass `tx` when already inside a transaction (provisioning does), and the lock
 * joins that transaction instead of opening a second one.
 */
export async function updateOrgSettings(
  prisma: PrismaService,
  organisationId: string,
  mutate: (current: OrgSettings) => OrgSettings,
): Promise<OrgSettings> {
  return prisma.$transaction((inner) => applyLocked(inner, organisationId, mutate));
}

/**
 * The same thing, joined to a transaction the caller already opened.
 *
 * Pack provisioning runs as one atomic unit, so it cannot open a second
 * transaction; it locks the row inside its own.
 */
export async function updateOrgSettingsIn(
  tx: Tx,
  organisationId: string,
  mutate: (current: OrgSettings) => OrgSettings,
): Promise<OrgSettings> {
  return applyLocked(tx, organisationId, mutate);
}

async function applyLocked(
  tx: Tx,
  organisationId: string,
  mutate: (current: OrgSettings) => OrgSettings,
): Promise<OrgSettings> {
  /*
   * FOR UPDATE holds the Organisation row until this transaction commits, so a
   * second writer blocks here rather than racing us to the write. This is the
   * whole mechanism; everything below is ordinary code that happens to be safe
   * because of this line.
   */
  const rows = await tx.$queryRaw<{ settings: unknown }[]>`
    SELECT "settings" FROM "Organisation" WHERE "id" = ${organisationId} FOR UPDATE
  `;
  if (!rows.length) {
    // No row to lock: the tenant is gone. Say so rather than writing settings
    // for an organisation that does not exist.
    throw new Error(`Organisation ${organisationId} not found`);
  }

  const next = mutate(asObject(rows[0]?.settings));

  await tx.organisation.update({
    where: { id: organisationId },
    // Through `unknown`: callers hold typed policy objects, and Prisma's
    // InputJsonValue wants an index signature those interfaces do not declare.
    data: { settings: next as unknown as Prisma.InputJsonValue },
  });
  return next;
}

/**
 * Coerce whatever the driver returned into a plain object.
 *
 * A JSONB column can legitimately hold `null`, and a driver may hand back either
 * a parsed object or the raw string depending on how it is configured — so both
 * are handled rather than assumed. Anything that is not an object becomes `{}`:
 * merging into an array or a scalar would throw away the caller's key silently,
 * and an empty object at least writes what they asked for.
 */
function asObject(value: unknown): OrgSettings {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as OrgSettings)
        : {};
    } catch {
      return {};
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as OrgSettings;
  return {};
}
