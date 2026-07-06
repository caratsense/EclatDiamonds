// One-off: remove DEMO/seed data, keep only REAL synced data + login bootstrap.
//
// Rule: synced rows carry a `legacyId` (PartyNo/StyleId/JewelId/JewelTransId…);
// demo/seed rows do not. So we:
//   1. wipe the net-new demo-only tables entirely (the sync never fills these), and
//   2. delete legacyId-null rows from the synced tables (keeping the real ones).
// KEPT: User, Store, Region, DiscountLimit, SchemePlan (needed to log in + scope).
// Children are deleted before parents to respect FKs.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Detach users from any demo party so demo parties can be removed.
  try { await prisma.user.updateMany({ data: { partyId: null } }); } catch {}

  // Net-new demo-only tables (sync never populates) — wipe entirely (children first).
  const wipe = [
    "leadNote", "occasionReminder", "lead",
    "quoteLine", "quote",
    "checkIn", "attendanceRecord", "leaveRequest", "commission",
    "ticketMessage", "ticket",
    "returnPhoto", "returnRecord",
    "discountRequest",
    "marketingAsset", "campaignStore", "marketingCampaign",
    "newStoreChecklistItem", "newStoreMilestone", "newStoreVendor", "newStoreProject",
    "schemeInstallment", "schemeMember",
    "customOrderEvent", "customOrder",
    "task", "payment", "ledgerEntry",
  ];
  for (const m of wipe) {
    try { const r = await prisma[m].deleteMany({}); console.log("wiped", m, r.count); }
    catch (e) { console.log("skip", m, e.message); }
  }

  // Synced tables: drop demo rows (legacyId null), keep real (legacyId set). Children first.
  const trim = [
    "saleLine", "sale",
    "manufacturingOrderItem", "manufacturingOrder",
    "stockMovement", "stockItem",
    "product", "party", "metalRate",
  ];
  for (const m of trim) {
    try { const r = await prisma[m].deleteMany({ where: { legacyId: null } }); console.log("trimmed", m, r.count); }
    catch (e) { console.log("skip", m, e.message); }
  }

  console.log("CLEANUP DONE — only real (legacyId) data + login bootstrap remain.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
