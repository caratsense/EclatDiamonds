/**
 * READ-ONLY. Counts only. Deletes nothing, writes nothing.
 *
 * Answers one question before anyone runs cleanup-demo.mjs:
 * how much of this database would that script actually destroy?
 *
 * cleanup-demo.mjs has two lists with very different behaviour:
 *   - `wipe`  -> deleteMany({}) with NO filter. Every row goes, demo or real.
 *   - `trim`  -> deleteMany({ legacyId: null }). Only rows the sync never wrote.
 *
 * On a database nobody has used, `wipe` is harmless. On a live one it removes
 * real leads, quotes, tickets, attendance and payments, because app-created
 * rows have no legacyId either. This prints both numbers so that is a decision
 * rather than a surprise.
 *
 *   cd backend && DATABASE_URL="<target>" node scripts/audit-demo-rows.mjs
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Mirrors cleanup-demo.mjs exactly — keep in step if that file changes.
const WIPE = [
  "leadNote", "occasionReminder", "lead", "quoteLine", "quote",
  "checkIn", "attendanceRecord", "leaveRequest", "commission",
  "ticketMessage", "ticket", "returnPhoto", "returnRecord", "discountRequest",
  "marketingAsset", "campaignStore", "marketingCampaign",
  "newStoreChecklistItem", "newStoreMilestone", "newStoreVendor", "newStoreProject",
  "schemeInstallment", "schemeMember", "customOrderEvent", "customOrder",
  "task", "payment", "ledgerEntry",
];

const TRIM = [
  "saleLine", "sale", "manufacturingOrderItem", "manufacturingOrder",
  "stockMovement", "stockItem", "product", "party", "metalRate",
];

const n = (v) => String(v).padStart(8);

async function main() {
  console.log(`\nTarget: ${(process.env.DATABASE_URL || "").replace(/\/\/[^@]*@/, "//***@")}\n`);

  console.log("UNCONDITIONAL WIPE — every one of these rows is deleted, real or not");
  console.log("─".repeat(64));
  let wipeTotal = 0;
  for (const m of WIPE) {
    try {
      const c = await prisma[m].count();
      wipeTotal += c;
      if (c > 0) console.log(`${n(c)}  ${m}`);
    } catch (e) {
      console.log(`${n("?")}  ${m}  (${e.message.split("\n")[0]})`);
    }
  }
  console.log("─".repeat(64));
  console.log(`${n(wipeTotal)}  TOTAL ROWS DESTROYED UNCONDITIONALLY\n`);

  console.log("FILTERED TRIM — only rows with no legacyId (never came from the sync)");
  console.log("─".repeat(64));
  let demo = 0, real = 0;
  for (const m of TRIM) {
    try {
      const [d, r] = await Promise.all([
        prisma[m].count({ where: { legacyId: null } }),
        prisma[m].count({ where: { NOT: { legacyId: null } } }),
      ]);
      demo += d; real += r;
      if (d + r > 0) console.log(`${n(d)} deleted  ${n(r)} kept   ${m}`);
    } catch (e) {
      console.log(`${n("?")}           ${m}  (${e.message.split("\n")[0]})`);
    }
  }
  console.log("─".repeat(64));
  console.log(`${n(demo)} deleted  ${n(real)} kept   TOTAL\n`);

  if (real === 0 && demo > 0) {
    console.log("NOTE: nothing carries a legacyId, so the sync has never written here.");
    console.log("      Every row above is app-created or seeded — none of it is Gati data.\n");
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
