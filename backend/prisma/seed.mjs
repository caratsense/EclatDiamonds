// Eclat / CaratSense dev seed — idempotent (upsert-based).
// Mirrors the frontend mocks so wired pages render realistic Indian-jewelry data
// across the 3 seeded stores. Run: npm run db:seed (after `prisma migrate dev`).
//
// Demo logins (all password: "password123"):
//   priya.rep@caratsense.in        salesperson   (Surat — Main only)
//   aarav.mehta@caratsense.in      store_manager (Surat — Main)
//   karan.malhotra@caratsense.in   store_manager (Mumbai — Bandra)
//   neelam.area@caratsense.in      area_manager  (West India region)
//   head.office@caratsense.in      head_office   (all stores)
import { Prisma, PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { seedModules } from "./seed-modules.mjs";

const ORGANISATION_ID = "org_eclat";
const basePrisma = new PrismaClient();

// Keep this legacy-rich demo seed tenant-safe without duplicating
// `organisationId` across every fixture. The model list comes from the generated
// schema, so adding a new tenant-owned model cannot silently make the seed write
// an unscoped row. Nested creates still need the tenant key explicitly because
// Prisma query extensions run at the top-level operation boundary.
const organisationModels = new Set(
  Prisma.dmmf.datamodel.models
    .filter((model) =>
      model.fields.some(
        (field) => field.name === "organisationId" && field.isRequired,
      ),
    )
    .map((model) => model.name),
);

const withOrganisation = (data) => ({
  ...data,
  organisationId: data.organisationId ?? ORGANISATION_ID,
});

const prisma = basePrisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!organisationModels.has(model)) return query(args);

        if (operation === "create") args.data = withOrganisation(args.data);
        if (operation === "createMany" || operation === "createManyAndReturn") {
          args.data = Array.isArray(args.data)
            ? args.data.map(withOrganisation)
            : withOrganisation(args.data);
        }
        if (operation === "upsert") {
          args.where = { ...args.where, organisationId: ORGANISATION_ID };
          args.create = withOrganisation(args.create);
        }
        if (
          [
            "findUnique",
            "findUniqueOrThrow",
            "findFirst",
            "findFirstOrThrow",
            "findMany",
            "count",
            "aggregate",
            "groupBy",
            "update",
            "updateMany",
            "updateManyAndReturn",
            "delete",
            "deleteMany",
          ].includes(operation)
        ) {
          args.where = { ...(args.where ?? {}), organisationId: ORGANISATION_ID };
        }
        return query(args);
      },
    },
  },
});
const D = (n) => n.toString();
const PASSWORD = "password123";

function daysAgo(n) {
  const d = new Date();
  d.setHours(10, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

async function main() {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  await basePrisma.organisation.upsert({
    where: { slug: "eclat" },
    update: {
      name: "Eclat",
      status: "active",
      industryPackCode: "jewellery",
      industryPackVersion: 1,
    },
    create: {
      id: ORGANISATION_ID,
      slug: "eclat",
      name: "Eclat",
      status: "active",
      industryPackCode: "jewellery",
      industryPackVersion: 1,
    },
  });

  // --- Region + stores (stable ids = frontend store ids) ---
  const west = await prisma.region.upsert({
    where: {
      organisationId_code: { organisationId: ORGANISATION_ID, code: "WEST" },
    },
    update: {},
    create: { name: "West India", code: "WEST" },
  });

  const storeDefs = [
    { id: "surat-main", code: "surat-main", name: "Surat — Main", city: "Surat", latitude: "21.1859000", longitude: "72.8081000", geofenceRadiusM: 75 },
    { id: "mumbai-bandra", code: "mumbai-bandra", name: "Mumbai — Bandra", city: "Mumbai", latitude: "19.0651400", longitude: "72.8307538", geofenceRadiusM: 60 },
    { id: "ahmedabad-cg", code: "ahmedabad-cg", name: "Ahmedabad — C.G. Road", city: "Ahmedabad", latitude: "23.0298000", longitude: "72.5616000", geofenceRadiusM: 80 },
  ];
  for (const s of storeDefs) {
    await prisma.store.upsert({
      where: { id: s.id },
      update: { name: s.name, city: s.city, regionId: west.id, code: s.code, latitude: s.latitude, longitude: s.longitude, geofenceRadiusM: s.geofenceRadiusM },
      create: { ...s, regionId: west.id },
    });
  }
  // Synthetic aggregate ("All Stores") for broad roles.
  await prisma.store.upsert({
    where: { id: "all" },
    update: {},
    create: { id: "all", code: "all", name: "All Stores", city: "Pan-India", isAggregate: true },
  });

  // --- Discount limits (Module 15) — GLOBAL caps (storeId=null). Gold is never
  // discounted; caps are split into diamond% / making%. maxPercent kept for back-compat.
  //   store_manager -> diamond 5%  / making 10%
  //   head_office   -> diamond 100%/ making 100%
  // (area_manager was collapsed into store_manager — no cap tier for it.)
  // maxPercent is the cap on a QUOTE discount (one % off making + diamond). Eclat's
  // rule: a salesperson's quote discount above 5% needs a manager. Demo data for
  // this org only — no other tenant gets it; production sets it through
  // POST /discounts/limits.
  const limits = [
    { role: "salesperson", maxPercent: "5.00", maxDiamondPercent: "2.00", maxMakingPercent: "5.00" },
    { role: "store_manager", maxPercent: "10.00", maxDiamondPercent: "5.00", maxMakingPercent: "10.00" },
    { role: "head_office", maxPercent: "100.00", maxDiamondPercent: "100.00", maxMakingPercent: "100.00" },
  ];
  for (const { role, maxPercent, maxDiamondPercent, maxMakingPercent } of limits) {
    const data = { maxPercent, maxDiamondPercent, maxMakingPercent };
    const existing = await prisma.discountLimit.findFirst({ where: { role, storeId: null } });
    if (existing) await prisma.discountLimit.update({ where: { id: existing.id }, data });
    else await prisma.discountLimit.create({ data: { role, ...data } });
  }

  // --- Dead stock (Block 9) — Eclat asked for 90 days across the board. Seeded
  // as THIS tenant's default rule, never as a platform constant: every other
  // tenant keeps the 180-day platform default until it decides otherwise.
  // Created only when absent, so a head office that has since changed the rule
  // is not reset by a re-seed.
  const eclatDefaultRule = await prisma.deadStockPolicy.findFirst({ where: { category: null } });
  if (!eclatDefaultRule) {
    await prisma.deadStockPolicy.create({ data: { category: null, thresholdDays: 90 } });
  }

  // --- Users across roles ---
  const userDefs = [
    { id: "u-rep-priya", name: "Priya Verma", email: "priya.rep@caratsense.in", initials: "PV", role: "salesperson", stores: ["surat-main"] },
    { id: "u-sm-aarav", name: "Aarav Mehta", email: "aarav.mehta@caratsense.in", initials: "AM", role: "store_manager", stores: ["surat-main"] },
    { id: "u-sm-karan", name: "Karan Malhotra", email: "karan.malhotra@caratsense.in", initials: "KM", role: "store_manager", stores: ["mumbai-bandra"] },
    { id: "u-am-neelam", name: "Neelam Rao", email: "neelam.area@caratsense.in", initials: "NR", role: "store_manager", stores: ["surat-main", "mumbai-bandra", "ahmedabad-cg"] },
    { id: "u-ho", name: "Head Office", email: "head.office@caratsense.in", initials: "HO", role: "head_office", stores: ["surat-main", "mumbai-bandra", "ahmedabad-cg"] },
    { id: "u-rep-rina", name: "Rina Trivedi", email: "rina.rep@caratsense.in", initials: "RT", role: "salesperson", stores: ["ahmedabad-cg"] },
  ];
  for (const u of userDefs) {
    // Upsert by email (unique); capture the real id (may differ from u.id if pre-existing).
    const saved = await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name, initials: u.initials, role: u.role, passwordHash, isActive: true },
      create: { id: u.id, name: u.name, email: u.email, initials: u.initials, role: u.role, passwordHash },
    });
    u.resolvedId = saved.id;
    for (const storeId of u.stores) {
      await prisma.userStore.upsert({
        where: { userId_storeId: { userId: saved.id, storeId } },
        update: {},
        create: { userId: saved.id, storeId, isPrimary: u.stores[0] === storeId },
      });
    }
  }
  const uid = (fixed) => userDefs.find((u) => u.id === fixed)?.resolvedId ?? fixed;

  // --- Parties (customers) ---
  const parties = [
    { id: "pty-priya-s", name: "Priya Sharma", phone: "+91 98250 11234", storeId: "surat-main" },
    { id: "pty-meera", name: "Meera Iyer", phone: "+91 98198 33445", storeId: "surat-main" },
    { id: "pty-neha", name: "Neha Kapoor", phone: "+91 98201 33221", storeId: "mumbai-bandra" },
    { id: "pty-sanjay", name: "Sanjay Mehta", phone: "+91 99098 65432", storeId: "ahmedabad-cg" },
  ];
  for (const p of parties) {
    await prisma.party.upsert({
      where: { id: p.id },
      update: {},
      create: { id: p.id, name: p.name, phone: p.phone, storeId: p.storeId, types: ["customer"] },
    });
  }

  // --- Products (Module 5 catalogue) — mirrors frontend mock ---
  const products = [
    { id: "p-001", sku: "NK-TEMPLE-22", name: "Lakshmi Temple Necklace Set", category: "necklace", metal: "gold_22k", karat: 22, weightGrams: "62.400", caratWeight: "0", price: "498000", availability: "in_stock", storeId: "surat-main", bestSeller: true, description: "Antique-finish 22K temple jewellery set with Lakshmi motif and matching jhumkas." },
    { id: "p-002", sku: "RG-SOL-18", name: "Aurora Solitaire Ring", category: "ring", metal: "gold_18k", karat: 18, weightGrams: "4.200", caratWeight: "0.500", price: "142000", costPrice: "98000", availability: "in_stock", storeId: "surat-main", description: "18K white-gold solitaire ring with a 0.50 ct VS-clarity round brilliant diamond." },
    { id: "p-003", sku: "BN-ROSE-18", name: "Blush Rose-Gold Bangles (Pair)", category: "bangle", metal: "rose_gold_18k", karat: 18, weightGrams: "28.600", caratWeight: "1.200", price: "168000", costPrice: "120000", availability: "lead_time", leadTimeDays: 14, storeId: "surat-main", description: "Pair of 18K rose-gold bangles with pavé diamond accents. Made to order." },
    { id: "p-004", sku: "ER-CHAND-22", name: "Chandbali Jhumka Earrings", category: "earrings", metal: "gold_22k", karat: 22, weightGrams: "18.900", caratWeight: "0", price: "151000", availability: "in_stock", storeId: "mumbai-bandra", description: "Traditional 22K chandbali jhumkas with intricate filigree and pearl drops." },
    { id: "p-005", sku: "BR-TENNIS-18", name: "Eternity Tennis Bracelet", category: "bracelet", metal: "gold_18k", karat: 18, weightGrams: "12.100", caratWeight: "2.100", price: "338000", costPrice: "250000", availability: "lead_time", leadTimeDays: 21, storeId: "mumbai-bandra", description: "18K white-gold tennis bracelet set with 2.10 ct of VVS round diamonds." },
    { id: "p-006", sku: "PD-MANGAL-22", name: "Classic Mangalsutra Pendant", category: "pendant", metal: "gold_22k", karat: 22, weightGrams: "8.400", caratWeight: "0.180", price: "64000", availability: "in_stock", storeId: "ahmedabad-cg", description: "22K mangalsutra pendant with black beads and a diamond-studded centre." },
    { id: "p-007", sku: "CH-ROPE-22", name: "Rope-Link Gold Chain (28 g)", category: "chain", metal: "gold_22k", karat: 22, weightGrams: "28.000", caratWeight: "0", price: "198000", availability: "in_stock", storeId: "ahmedabad-cg", bestSeller: true, description: "Hand-finished 22K rope-link chain, gents 20-inch." },
    { id: "p-009", sku: "RG-BAND-PT", name: "Infinity Eternity Band", category: "ring", metal: "platinum", karat: 0, weightGrams: "5.600", caratWeight: "0.750", price: "121000", availability: "in_stock", storeId: "surat-main", description: "Platinum eternity band with 0.75 ct of channel-set round diamonds." },
    { id: "p-011", sku: "BN-KADA-22", name: "Gents Heritage Kada (45 g)", category: "bangle", metal: "gold_22k", karat: 22, weightGrams: "45.200", caratWeight: "0", price: "322000", availability: "in_stock", storeId: "surat-main", description: "Solid 22K gents kada with a matte-and-cut hand finish." },
    { id: "p-012", sku: "PD-HALO-18", name: "Halo Diamond Pendant", category: "pendant", metal: "gold_18k", karat: 18, weightGrams: "3.100", caratWeight: "0.450", price: "78000", availability: "lead_time", leadTimeDays: 10, storeId: "mumbai-bandra", description: "18K rose-gold halo pendant with a 0.30 ct centre and pavé halo." },
  ];
  for (const p of products) {
    const { id, ...rest } = p;
    await prisma.product.upsert({
      where: { id },
      update: { ...rest, embedding: [] },
      create: { id, ...rest, embedding: [] },
    });
  }

  // --- Stock items (Module 9) — mirrors frontend mock ---
  const stock = [
    { id: "stk-9001", sku: "RNG-22-0451", name: "22K Plain Gold Ring", category: "ring", karat: 22, storeId: "surat-main", grossWeight: "4.850", ageDays: 18, status: "in_stock", tagPrice: "41200" },
    { id: "stk-9002", sku: "NCK-22-1188", name: "22K Kundan Necklace", category: "necklace", karat: 22, storeId: "surat-main", grossWeight: "96.400", ageDays: 214, status: "dead_stock", tagPrice: "842000" },
    { id: "stk-9003", sku: "BNG-22-0623", name: "22K Antique Bangle (pair)", category: "bangle", karat: 22, storeId: "mumbai-bandra", grossWeight: "58.200", ageDays: 132, status: "aging", tagPrice: "512000" },
    { id: "stk-9004", sku: "ERG-18-0204", name: "18K Diamond Studs", category: "earrings", karat: 18, storeId: "mumbai-bandra", grossWeight: "3.100", ageDays: 9, status: "in_stock", tagPrice: "68500" },
    { id: "stk-9005", sku: "CHN-22-2290", name: "22K Rope Chain", category: "chain", karat: 22, storeId: "ahmedabad-cg", grossWeight: "14.700", ageDays: 167, status: "aging", tagPrice: "124000" },
    { id: "stk-9006", sku: "PND-18-0712", name: "18K Solitaire Pendant", category: "pendant", karat: 18, storeId: "ahmedabad-cg", grossWeight: "2.400", ageDays: 256, status: "dead_stock", tagPrice: "156000" },
    { id: "stk-9007", sku: "MNG-22-0339", name: "22K Mangalsutra", category: "necklace", karat: 22, storeId: "surat-main", grossWeight: "21.600", ageDays: 42, status: "reserved", tagPrice: "184000" },
    { id: "stk-9008", sku: "BRC-22-0590", name: "22K Ladies Bracelet", category: "bracelet", karat: 22, storeId: "mumbai-bandra", grossWeight: "12.300", ageDays: 88, status: "in_stock", tagPrice: "104000" },
  ];
  for (const s of stock) {
    const { id, ...rest } = s;
    await prisma.stockItem.upsert({ where: { id }, update: rest, create: { id, ...rest } });
  }

  // --- Leads (Module 1) ---
  const leads = [
    { id: "ld-2041", ref: "LD-2041", storeId: "surat-main", partyId: "pty-priya-s", ownerId: "u-sm-aarav", customerName: "Priya Sharma", phone: "+91 98250 11234", value: "285000", source: "walk_in", stage: "inquiry", interest: "Bridal — 22K gold necklace set", createdAt: daysAgo(3) },
    { id: "ld-2042", ref: "LD-2042", storeId: "surat-main", ownerId: "u-rep-priya", customerName: "Rohan Desai", phone: "+91 99041 55678", value: "64000", source: "whatsapp", stage: "inquiry", interest: "Diamond solitaire ring (0.50 ct)", createdAt: daysAgo(2) },
    { id: "ld-2043", ref: "LD-2043", storeId: "surat-main", partyId: "pty-meera", ownerId: "u-sm-aarav", customerName: "Meera Iyer", phone: "+91 98198 33445", value: "152000", source: "instagram", stage: "quotation", interest: "18K rose-gold bangles pair", createdAt: daysAgo(7) },
    { id: "ld-2045", ref: "LD-2045", storeId: "surat-main", ownerId: "u-rep-priya", customerName: "Sneha Kulkarni", phone: "+91 98765 22110", value: "98000", source: "website", stage: "order_placed", interest: "Diamond pendant + earrings", createdAt: daysAgo(15) },
    { id: "ld-3010", ref: "LD-3010", storeId: "mumbai-bandra", ownerId: "u-sm-karan", customerName: "Fatima Shaikh", phone: "+91 98200 90011", value: "175000", source: "walk_in", stage: "inquiry", interest: "Polki choker — engagement", createdAt: daysAgo(2) },
    { id: "ld-3011", ref: "LD-3011", storeId: "mumbai-bandra", partyId: "pty-neha", ownerId: "u-sm-karan", customerName: "Neha Kapoor", phone: "+91 98201 33221", value: "340000", source: "instagram", stage: "quotation", interest: "Diamond tennis bracelet (2.1 ct)", createdAt: daysAgo(8) },
    { id: "ld-4007", ref: "LD-4007", storeId: "ahmedabad-cg", ownerId: "u-rep-rina", customerName: "Hetal Patel", phone: "+91 99099 12345", value: "88000", source: "whatsapp", stage: "inquiry", interest: "Light-weight daily-wear earrings", createdAt: daysAgo(1) },
    { id: "ld-4008", ref: "LD-4008", storeId: "ahmedabad-cg", partyId: "pty-sanjay", ownerId: "u-rep-rina", customerName: "Sanjay Mehta", phone: "+91 99098 65432", value: "510000", source: "walk_in", stage: "quotation", interest: "Full bridal set — Navratna", createdAt: daysAgo(10) },
  ];
  for (const l of leads) {
    const { id, ...rest } = l;
    rest.ownerId = uid(rest.ownerId);
    await prisma.lead.upsert({ where: { id }, update: {}, create: { id, ...rest, lastActivity: rest.createdAt } });
  }
  await prisma.leadNote.upsert({
    where: { id: "note-ld2041-1" },
    update: {},
    create: { id: "note-ld2041-1", leadId: "ld-2041", authorName: "Aarav Mehta", text: "Wedding in November. Prefers antique temple-jewellery design." },
  });
  await prisma.occasionReminder.upsert({
    where: { id: "rem-ld2041-1" },
    update: {},
    create: { id: "rem-ld2041-1", leadId: "ld-2041", occasion: "Anniversary", date: new Date("2026-11-22") },
  });

  // --- Quotes (Module 2) with lines + pricing rollup ---
  const GST = 0.03;
  const quoteDefs = [
    {
      id: "qt-1042", ref: "QT-1042", storeId: "surat-main", partyId: "pty-meera", leadId: "ld-2043", assignedRepId: "u-sm-aarav",
      customerName: "Meera Iyer", phone: "+91 98198 33445", status: "shared", createdAt: daysAgo(5), validUntil: daysAgo(-9),
      redeemable: ["surat-main", "mumbai-bandra", "ahmedabad-cg"],
      lines: [{ description: "18K rose-gold bangles (pair)", karat: 18, weightGrams: 26.4, goldRatePerGram: 5920, makingCharges: 18480, stoneCharges: 9500, caratWeight: 1.2 }],
    },
    {
      id: "qt-1051", ref: "QT-1051", storeId: "mumbai-bandra", partyId: "pty-neha", leadId: "ld-3011", assignedRepId: "u-sm-karan",
      customerName: "Neha Kapoor", phone: "+91 98201 33221", status: "shared", createdAt: daysAgo(4), validUntil: daysAgo(-10),
      redeemable: ["mumbai-bandra", "surat-main"],
      lines: [{ description: "18K tennis bracelet (2.1 ct)", karat: 18, weightGrams: 12.1, goldRatePerGram: 5920, makingCharges: 24200, stoneCharges: 232000, caratWeight: 2.1 }],
    },
    {
      id: "qt-1055", ref: "QT-1055", storeId: "ahmedabad-cg", partyId: "pty-sanjay", leadId: "ld-4008", assignedRepId: "u-rep-rina",
      customerName: "Sanjay Mehta", phone: "+91 99098 65432", status: "accepted", createdAt: daysAgo(7), validUntil: daysAgo(-7),
      redeemable: ["ahmedabad-cg", "surat-main", "mumbai-bandra"],
      lines: [{ description: "Navratna bridal set — 22K", karat: 22, weightGrams: 86.0, goldRatePerGram: 7180, makingCharges: 128000, stoneCharges: 96000, caratWeight: 0 }],
    },
  ];
  for (const q of quoteDefs) {
    let metalValue = 0, making = 0, stone = 0;
    for (const l of q.lines) { metalValue += l.weightGrams * l.goldRatePerGram; making += l.makingCharges; stone += l.stoneCharges; }
    const taxable = metalValue + making + stone;
    const gst = taxable * GST;
    await prisma.quoteLine.deleteMany({ where: { quoteId: q.id } });
    await prisma.quoteRedeemableStore.deleteMany({ where: { quoteId: q.id } });
    await prisma.quote.upsert({
      where: { id: q.id },
      update: {},
      create: {
        id: q.id, ref: q.ref, storeId: q.storeId, partyId: q.partyId, leadId: q.leadId, assignedRepId: uid(q.assignedRepId),
        customerName: q.customerName, phone: q.phone, status: q.status, createdAt: q.createdAt, validUntil: q.validUntil,
        metalValue: D(metalValue), makingCharges: D(making), stoneCharges: D(stone),
        taxableAmount: D(taxable), gstAmount: D(gst), grandTotal: D(taxable + gst),
      },
    });
    for (const l of q.lines) {
      await prisma.quoteLine.create({
        data: {
          quoteId: q.id, description: l.description, karat: l.karat,
          weightGrams: D(l.weightGrams), goldRatePerGram: D(l.goldRatePerGram),
          makingCharges: D(l.makingCharges), stoneCharges: D(l.stoneCharges), caratWeight: D(l.caratWeight),
        },
      });
    }
    for (const sid of q.redeemable) {
      await prisma.quoteRedeemableStore.create({ data: { quoteId: q.id, storeId: sid } });
    }
  }

  // --- Sales (Module 10 DSR source) — drives dashboard KPIs/charts ---
  // A spread across the last 7 days, plus several "today" rows per store.
  const salesSpec = [
    { store: "surat-main", rep: "u-rep-priya", party: "pty-priya-s", offsets: [0, 0, 1, 2, 3, 4, 5, 6], base: 410000 },
    { store: "mumbai-bandra", rep: "u-sm-karan", party: "pty-neha", offsets: [0, 0, 0, 1, 2, 3, 5, 6], base: 540000 },
    { store: "ahmedabad-cg", rep: "u-rep-rina", party: "pty-sanjay", offsets: [0, 1, 2, 3, 4, 6], base: 295000 },
  ];
  // Products per store, cycled to give each sale a line (drives DSR goldGrams + movers).
  const storeProducts = {
    "surat-main": [
      { productId: "p-001", desc: "22K temple necklace set", net: 60.2 },
      { productId: "p-007", desc: "22K rope chain", net: 27.4 },
      { productId: "p-011", desc: "22K gents kada", net: 44.1 },
      { productId: "p-002", desc: "18K solitaire ring", net: 4.0 },
    ],
    "mumbai-bandra": [
      { productId: "p-004", desc: "22K chandbali jhumkas", net: 18.2 },
      { productId: "p-005", desc: "18K tennis bracelet", net: 11.8 },
      { productId: "p-012", desc: "18K halo pendant", net: 3.0 },
    ],
    "ahmedabad-cg": [
      { productId: "p-007", desc: "22K rope chain", net: 27.4 },
      { productId: "p-006", desc: "22K mangalsutra pendant", net: 8.1 },
    ],
  };
  // Re-seed sales fresh so each carries a SaleLine (DSR goldGrams + movers source).
  await prisma.saleLine.deleteMany({ where: { sale: { docNo: { startsWith: "INV-" } } } });
  await prisma.sale.deleteMany({ where: { docNo: { startsWith: "INV-" } } });
  let docSeq = 1000;
  for (const spec of salesSpec) {
    let i = 0;
    const prods = storeProducts[spec.store];
    for (const off of spec.offsets) {
      docSeq += 1;
      const amount = spec.base + ((i * 37000 + off * 12000) % 220000);
      const docNo = `INV-${spec.store.slice(0, 3).toUpperCase()}-${docSeq}`;
      const total = amount;
      const gross = Math.round(total / 1.03);
      const tax = total - gross;
      const saleId = `sale-${spec.store.slice(0, 3)}-${docSeq}`;
      const line = prods[i % prods.length];
      await prisma.sale.upsert({
        where: { storeId_docNo_docType: { storeId: spec.store, docNo, docType: "sale" } },
        update: {},
        create: {
          id: saleId,
          storeId: spec.store, partyId: spec.party, salesPersonId: uid(spec.rep),
          docNo, docType: "sale", docDate: daysAgo(off),
          grossAmount: D(gross), taxAmount: D(tax), totalAmount: D(total),
          lines: {
            create: {
              organisationId: ORGANISATION_ID,
              productId: line.productId,
              description: line.desc,
              netWeight: D(line.net),
              metalAmount: D(gross),
              lineTotal: D(total),
            },
          },
        },
      });
      i += 1;
    }
  }

  // --- Check-ins (footfall, Module 7) for "today" KPIs ---
  await prisma.checkIn.deleteMany({ where: { timeIn: { gte: daysAgo(0) } } });
  const footfall = { "surat-main": 6, "mumbai-bandra": 9, "ahmedabad-cg": 4 };
  for (const [storeId, n] of Object.entries(footfall)) {
    for (let k = 0; k < n; k++) {
      await prisma.checkIn.create({
        data: { storeId, customerName: `Walk-in ${k + 1}`, purpose: "browsing", outcome: "in_store", timeIn: daysAgo(0) },
      });
    }
  }

  // --- Custom orders (pending orders KPI, Module 8) ---
  const customOrders = [
    { id: "co-1", ref: "CO-1001", storeId: "surat-main", customerName: "Priya Sharma", item: "Bridal necklace set", stage: "designing", bookedOn: daysAgo(12) },
    { id: "co-2", ref: "CO-1002", storeId: "surat-main", customerName: "Rohan Desai", item: "Solitaire ring", stage: "casting", bookedOn: daysAgo(6) },
    { id: "co-3", ref: "CO-1003", storeId: "mumbai-bandra", customerName: "Neha Kapoor", item: "Tennis bracelet", stage: "stone_setting", bookedOn: daysAgo(9) },
    { id: "co-4", ref: "CO-1004", storeId: "mumbai-bandra", customerName: "Fatima Shaikh", item: "Polki choker", stage: "booked", bookedOn: daysAgo(2) },
    { id: "co-5", ref: "CO-1005", storeId: "ahmedabad-cg", customerName: "Sanjay Mehta", item: "Navratna set", stage: "qc", bookedOn: daysAgo(20) },
    { id: "co-6", ref: "CO-1006", storeId: "ahmedabad-cg", customerName: "Hetal Patel", item: "Daily-wear earrings", stage: "delivered", bookedOn: daysAgo(25) },
  ];
  for (const c of customOrders) {
    const { id, ...rest } = c;
    await prisma.customOrder.upsert({ where: { id }, update: {}, create: { id, ...rest, ownerRole: "salesperson" } });
  }

  // --- Collections due (AR ledger, Module 12) ---
  const ar = [
    { id: "ar-1", storeId: "surat-main", partyId: "pty-priya-s", amount: "142000" },
    { id: "ar-2", storeId: "mumbai-bandra", partyId: "pty-neha", amount: "168000" },
    { id: "ar-3", storeId: "ahmedabad-cg", partyId: "pty-sanjay", amount: "215000" },
  ];
  for (const e of ar) {
    const { id, ...rest } = e;
    await prisma.ledgerEntry.upsert({
      where: { id },
      update: {},
      create: { id, ...rest, kind: "AR", side: "debit", status: "open", entryDate: daysAgo(5), reference: "Pending advance" },
    });
  }

  // --- Discount requests (Module 15): one auto-approved, one escalated ---
  await prisma.discountRequest.upsert({
    where: { id: "dr-1" },
    update: {},
    create: {
      id: "dr-1", ref: "DR-1001", storeId: "surat-main", customerName: "Meera Iyer", item: "Rose-gold bangles",
      percent: "1.50", status: "approved", requestedById: uid("u-rep-priya"), requestedRole: "salesperson",
      approvedById: uid("u-rep-priya"), approvedRole: "salesperson", decidedAt: daysAgo(2),
    },
  });
  await prisma.discountRequest.upsert({
    where: { id: "dr-2" },
    update: {},
    create: {
      id: "dr-2", ref: "DR-1002", storeId: "mumbai-bandra", customerName: "Neha Kapoor", item: "Tennis bracelet",
      percent: "7.00", status: "escalated", requestedById: uid("u-sm-karan"), requestedRole: "store_manager",
    },
  });
  // The live service mints DR-(1000 + sequence). Seeded human-readable refs
  // therefore reserve sequence values 1 and 2 as well. GREATEST keeps this
  // idempotent and never rewinds a counter in a reused development database.
  await prisma.$executeRaw`
    INSERT INTO "DocSequence" ("scope", "next", "updatedAt")
    VALUES ('DR:global', 3, CURRENT_TIMESTAMP)
    ON CONFLICT ("scope") DO UPDATE
      SET "next" = GREATEST("DocSequence"."next", EXCLUDED."next"),
          "updatedAt" = CURRENT_TIMESTAMP
  `;

  // --- Gold-savings scheme plans (Module 17) ---
  // Intentionally NOT seeded. The client marked the gold-savings scheme LATER
  // (deferred) in the discovery call and never supplied plan names or terms, so
  // seeding invented plans put placeholder branding in front of users. Head
  // Office now creates the real plan in-app (Loyalty > Scheme plans), optionally
  // starting from a template. The active Module 17 build is the referral wallet.

  // ==========================================================================
  // MODULE 4 — FINANCE: AP/AR ledger, expenses, income, budget + forecast rows
  // ==========================================================================
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const dateInMonth = (offset, day = 15) =>
    new Date(today.getFullYear(), today.getMonth() + offset, day, 10, 0, 0);

  // AP/AR rows (the finance ledger table).
  const financeLedger = [
    { id: "le-ar-1", storeId: "surat-main", partyId: "pty-meera", kind: "AR", side: "credit", amount: "2450000", narration: "Sales — Bridal", status: "partial", entryDate: dateInMonth(0, today.getDate()) },
    { id: "le-ap-1", storeId: null, partyId: null, kind: "AP", side: "debit", amount: "8800000", narration: "Bullion Purchase — MMTC-PAMP", status: "open", entryDate: dateInMonth(0, today.getDate()) },
    { id: "le-ar-2", storeId: "mumbai-bandra", partyId: "pty-neha", kind: "AR", side: "credit", amount: "1840000", narration: "Sales — Diamond", status: "cleared", entryDate: dateInMonth(0, today.getDate() - 1) },
    { id: "le-ap-2", storeId: "mumbai-bandra", partyId: null, kind: "AP", side: "debit", amount: "1250000", narration: "Rent — Bandra", status: "overdue", entryDate: dateInMonth(0, today.getDate() - 1) },
    { id: "le-ar-3", storeId: "ahmedabad-cg", partyId: "pty-sanjay", kind: "AR", side: "credit", amount: "620000", narration: "Sales — Gold Coin", status: "cleared", entryDate: dateInMonth(0, today.getDate() - 2) },
    { id: "le-ap-3", storeId: "surat-main", partyId: null, kind: "AP", side: "debit", amount: "940000", narration: "Karigar Wages", status: "partial", entryDate: dateInMonth(0, today.getDate() - 2) },
    { id: "le-ar-4", storeId: "surat-main", partyId: "pty-priya-s", kind: "AR", side: "credit", amount: "3120000", narration: "Sales — Polki", status: "open", entryDate: dateInMonth(0, today.getDate() - 3) },
    { id: "le-ap-4", storeId: "ahmedabad-cg", partyId: null, kind: "AP", side: "debit", amount: "186000", narration: "Utilities — Torrent Power", status: "cleared", entryDate: dateInMonth(0, today.getDate() - 3) },
  ];
  for (const e of financeLedger) {
    const { id, ...rest } = e;
    await prisma.ledgerEntry.upsert({ where: { id }, update: rest, create: { id, ...rest } });
  }

  // Operating expenses (MIS summary) per store, this month.
  const expenseRows = [
    { id: "le-exp-1", storeId: "surat-main", amount: "6200000", narration: "Operating Expense" },
    { id: "le-exp-2", storeId: "mumbai-bandra", amount: "7400000", narration: "Operating Expense" },
    { id: "le-exp-3", storeId: "ahmedabad-cg", amount: "4800000", narration: "Operating Expense" },
  ];
  for (const e of expenseRows) {
    const { id, ...rest } = e;
    await prisma.ledgerEntry.upsert({ where: { id }, update: rest, create: { id, ...rest, kind: "expense", side: "debit", status: "open", entryDate: dateInMonth(0, 5) } });
  }

  // Budget rows (status='budget') and cashflow forecast/expense rows (6 months).
  const budgetTargets = { "surat-main": "52000000", "mumbai-bandra": "68000000", "ahmedabad-cg": "41000000" };
  for (const [storeId, amount] of Object.entries(budgetTargets)) {
    await prisma.ledgerEntry.upsert({
      where: { id: `le-budget-${storeId}` },
      update: { amount },
      create: { id: `le-budget-${storeId}`, storeId, kind: "income", side: "credit", status: "budget", amount, narration: "Monthly budget target", entryDate: monthStart },
    });
  }
  // Forecast inflow + outflow rows for the cashflow chart (per month, surat-main as anchor).
  const cashflowPlan = [
    { off: 0, inflow: "0", rent: "4200000", sal: "9800000", ns: "6500000" },
    { off: 1, inflow: "128000000", rent: "4200000", sal: "9800000", ns: "11000000" },
    { off: 2, inflow: "156000000", rent: "4400000", sal: "10200000", ns: "14500000" },
    { off: 3, inflow: "168000000", rent: "4400000", sal: "10200000", ns: "9000000" },
    { off: 4, inflow: "214000000", rent: "4600000", sal: "11800000", ns: "4000000" },
    { off: 5, inflow: "198000000", rent: "4600000", sal: "11800000", ns: "2000000" },
  ];
  for (const c of cashflowPlan) {
    const ed = dateInMonth(c.off, 1);
    const rows = [
      { id: `cf-in-${c.off}`, kind: "income", side: "credit", status: "forecast", amount: c.inflow, narration: "Forecast inflow" },
      { id: `cf-rent-${c.off}`, kind: "expense", side: "debit", status: "forecast", amount: c.rent, narration: "Rentals" },
      { id: `cf-sal-${c.off}`, kind: "expense", side: "debit", status: "forecast", amount: c.sal, narration: "Salaries" },
      { id: `cf-ns-${c.off}`, kind: "expense", side: "debit", status: "forecast", amount: c.ns, narration: "New Store" },
    ];
    for (const r of rows) {
      const { id, ...rest } = r;
      if (c.off === 0 && id.startsWith("cf-in")) continue; // current month inflow comes from real sales
      await prisma.ledgerEntry.upsert({ where: { id }, update: rest, create: { id, ...rest, storeId: "surat-main", entryDate: ed } });
    }
  }

  // ==========================================================================
  // MODULE 6 — HRMS: staff attendance (geo), leave requests, commissions
  // ==========================================================================
  const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const at = (h, m) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m, 0);
  const attendance = [
    { id: "att-01", storeId: "surat-main", staffId: "s-101", staffName: "Priya Sharma", status: "present", checkInAt: at(9, 52), checkInLat: "21.1858000", checkInLng: "72.8082000", geoVerified: true },
    { id: "att-02", storeId: "surat-main", staffId: "s-102", staffName: "Rohan Desai", status: "late", checkInAt: at(10, 18), checkInLat: "21.1860000", checkInLng: "72.8080000", geoVerified: true },
    { id: "att-03", storeId: "surat-main", staffId: "s-103", staffName: "Anjali Patel", status: "present", checkInAt: at(9, 46), checkInLat: "21.1857000", checkInLng: "72.8083000", geoVerified: true },
    { id: "att-04", storeId: "surat-main", staffId: "s-104", staffName: "Vikram Joshi", status: "present", checkInAt: at(9, 38), checkInLat: "21.1860000", checkInLng: "72.8079000", geoVerified: true },
    { id: "att-05", storeId: "surat-main", staffId: "s-105", staffName: "Karan Mehta", status: "late", checkInAt: at(10, 41), checkInLat: "21.1872000", checkInLng: "72.8094000", geoVerified: false },
    { id: "att-06", storeId: "surat-main", staffId: "s-106", staffName: "Sneha Iyer", status: "on_leave", checkInAt: null, geoVerified: false },
    { id: "att-07", storeId: "mumbai-bandra", staffId: "s-201", staffName: "Aditya Nair", status: "present", checkInAt: at(10, 55), checkInLat: "19.0652000", checkInLng: "72.8307000", geoVerified: true },
    { id: "att-08", storeId: "mumbai-bandra", staffId: "s-202", staffName: "Fatima Shaikh", status: "late", checkInAt: at(11, 9), checkInLat: "19.0651000", checkInLng: "72.8308000", geoVerified: true },
    { id: "att-09", storeId: "mumbai-bandra", staffId: "s-203", staffName: "Deepak Rao", status: "absent", checkInAt: null, geoVerified: false },
    { id: "att-10", storeId: "ahmedabad-cg", staffId: "s-301", staffName: "Meera Trivedi", status: "present", checkInAt: at(10, 12), checkInLat: "23.0299000", checkInLng: "72.5617000", geoVerified: true },
    { id: "att-11", storeId: "ahmedabad-cg", staffId: "s-302", staffName: "Harsh Solanki", status: "present", checkInAt: at(10, 25), checkInLat: "23.0297000", checkInLng: "72.5615000", geoVerified: true },
  ];
  // The id carries the date it belongs to. Without that this upsert is only
  // idempotent on the day it first ran: `where` matches on (store, staff, date)
  // and the date moves every midnight, so the next day misses, falls to
  // `create`, and collides on the pinned id — P2002, and a failed deployment.
  // The composite key is the real identity; the id only has to not repeat.
  for (const a of attendance) {
    const { id, ...rest } = a;
    await prisma.attendanceRecord.upsert({
      where: { storeId_staffId_date: { storeId: a.storeId, staffId: a.staffId, date: todayDate } },
      update: rest,
      create: { id: `${id}-${todayDate.toISOString().slice(0, 10)}`, ...rest, date: todayDate },
    });
  }

  // --- Module 6 (client call 2026-07): shifts / batches, week-off, holidays ---
  // Mumbai — Bandra is a mall store running 2 shifts; a night/second-batch person
  // checking in in the afternoon is NOT late (lateness is vs their own shift).
  await prisma.store.update({ where: { id: "mumbai-bandra" }, data: { weekOffDay: 2 } }); // 2 = Tuesday

  const shiftDefs = [
    { id: "shift-mumbai-morning", storeId: "mumbai-bandra", name: "Morning", startTime: "10:00", endTime: "19:00", bufferMins: 15, isNightBatch: false },
    { id: "shift-mumbai-night", storeId: "mumbai-bandra", name: "Night", startTime: "14:00", endTime: "22:00", bufferMins: 15, isNightBatch: true },
  ];
  for (const s of shiftDefs) {
    const { id, ...rest } = s;
    await prisma.shift.upsert({ where: { id }, update: rest, create: { id, ...rest } });
  }

  const holidayDefs = [
    { id: "hol-mumbai-independence", storeId: "mumbai-bandra", date: new Date(Date.UTC(today.getFullYear(), 7, 15)), label: "Independence Day" },
  ];
  for (const h of holidayDefs) {
    const { id, ...rest } = h;
    await prisma.storeHoliday.upsert({
      where: { storeId_date: { storeId: h.storeId, date: h.date } },
      update: { label: h.label },
      // Same reason as attendance above, on a yearly clock: these dates are
      // pinned to today's year, so the id would collide next January.
      create: { id: `${id}-${h.date.getUTCFullYear()}`, ...rest },
    });
  }

  // Late-flag demo (FLAG ONLY, no salary math): Fatima (s-202) is late on 3 mornings
  // this month -> flagged; Aditya (s-201) is late once -> not flagged. Dates use UTC
  // so month-grouping is boundary-safe; isLate/lateMinutes are measured vs Morning shift.
  const utcDay = (day, h, m) => ({
    date: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), day)),
    checkInAt: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), day, h, m, 0)),
  });
  const lateDemo = [
    { id: "att-l1", staffId: "s-202", staffName: "Fatima Shaikh", lateMinutes: 25, ...utcDay(1, 10, 40) },
    { id: "att-l2", staffId: "s-202", staffName: "Fatima Shaikh", lateMinutes: 18, ...utcDay(2, 10, 33) },
    { id: "att-l3", staffId: "s-202", staffName: "Fatima Shaikh", lateMinutes: 40, ...utcDay(3, 10, 55) },
    { id: "att-l4", staffId: "s-201", staffName: "Aditya Nair", lateMinutes: 5, ...utcDay(2, 10, 20) },
  ];
  for (const a of lateDemo) {
    const { id, date, ...rest } = a;
    const base = { storeId: "mumbai-bandra", status: "late", isLate: true, shiftId: "shift-mumbai-morning" };
    await prisma.attendanceRecord.upsert({
      where: { storeId_staffId_date: { storeId: "mumbai-bandra", staffId: a.staffId, date } },
      update: { ...base, ...rest },
      // Same reason again, monthly: utcDay() builds these from the current
      // month, so the id would collide on the first seed run of the next one.
      create: { id: `${id}-${date.toISOString().slice(0, 10)}`, date, ...base, ...rest },
    });
  }

  const leaveReqs = [
    { id: "lv-01", storeId: "surat-main", staffId: "s-106", staffName: "Sneha Iyer", type: "sick", from: 0, to: 1, reason: "Fever, doctor advised rest.", status: "approved" },
    { id: "lv-02", storeId: "surat-main", staffId: "s-103", staffName: "Anjali Patel", type: "festival", from: 5, to: 5, reason: "Family pooja at home.", status: "pending" },
    { id: "lv-03", storeId: "mumbai-bandra", staffId: "s-202", staffName: "Fatima Shaikh", type: "casual", from: 2, to: 3, reason: "Out-of-town wedding.", status: "pending" },
    { id: "lv-04", storeId: "mumbai-bandra", staffId: "s-203", staffName: "Deepak Rao", type: "earned", from: 8, to: 11, reason: "Annual leave — hometown visit.", status: "pending" },
    { id: "lv-05", storeId: "ahmedabad-cg", staffId: "s-302", staffName: "Harsh Solanki", type: "casual", from: 4, to: 4, reason: "Personal work.", status: "rejected" },
  ];
  for (const l of leaveReqs) {
    const { id, from, to, ...rest } = l;
    const fromDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + from);
    const toDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + to);
    await prisma.leaveRequest.upsert({ where: { id }, update: { status: l.status }, create: { id, ...rest, fromDate, toDate } });
  }

  // Commissions (Module 6) — period = current YYYY-MM.
  const period = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const commissionDefs = [
    { userId: "u-rep-priya", storeId: "surat-main", salesValue: "4820000", rate: "1.20", amount: "57840" },
    { userId: "u-sm-karan", storeId: "mumbai-bandra", salesValue: "5310000", rate: "1.20", amount: "63720" },
    { userId: "u-rep-rina", storeId: "ahmedabad-cg", salesValue: "2180000", rate: "1.00", amount: "21800" },
    { userId: "u-sm-aarav", storeId: "surat-main", salesValue: "2640000", rate: "1.00", amount: "26400" },
  ];
  for (const c of commissionDefs) {
    const userId = uid(c.userId);
    await prisma.commission.upsert({
      where: { userId_period: { userId, period } },
      update: { salesValue: c.salesValue, rate: c.rate, amount: c.amount, storeId: c.storeId },
      create: { userId, period, storeId: c.storeId, salesValue: c.salesValue, rate: c.rate, amount: c.amount },
    });
  }

  // ==========================================================================
  // MODULE 7 — CHECK-INS: richer footfall log (rep<->customer), past + present
  // ==========================================================================
  const checkinDefs = [
    { id: "ci-01", storeId: "surat-main", partyId: "pty-priya-s", customerName: "Rajesh & Kavita Agarwal", phone: "+91 98250 11234", purpose: "bridal", outcome: "in_store", repId: "s-101", repName: "Priya Sharma", inH: 10, inM: 5, outH: null },
    { id: "ci-02", storeId: "surat-main", customerName: "Nilesh Bhatt", phone: "+91 99090 44521", purpose: "investment", outcome: "sale_closed", repId: "s-102", repName: "Rohan Desai", inH: 10, inM: 22, outH: 10, outM: 51 },
    { id: "ci-03", storeId: "surat-main", partyId: "pty-meera", customerName: "Hetal Shah", phone: "+91 98795 33210", purpose: "quote_followup", outcome: "in_store", repId: "s-101", repName: "Priya Sharma", inH: 10, inM: 40, outH: null },
    { id: "ci-04", storeId: "surat-main", customerName: "Imran Vohra", phone: "+91 97250 88123", purpose: "repair", outcome: "left", repId: "s-105", repName: "Karan Mehta", inH: 11, inM: 2, outH: 11, outM: 14 },
    { id: "ci-05", storeId: "surat-main", customerName: "Bina Patel", phone: "+91 98240 67788", purpose: "scheme", outcome: "quote_given", repId: "s-102", repName: "Rohan Desai", inH: 11, inM: 18, outH: 11, outM: 46 },
    { id: "ci-06", storeId: "surat-main", customerName: "Suresh Modi", phone: "+91 99780 12009", purpose: "bridal", outcome: "in_store", repId: "s-101", repName: "Priya Sharma", inH: 11, inM: 35, outH: null },
    { id: "ci-07", storeId: "surat-main", customerName: "Dharmesh Gandhi", phone: "+91 98251 90876", purpose: "other", outcome: "sale_closed", repId: "s-104", repName: "Vikram Joshi", inH: 12, inM: 8, outH: 12, outM: 39 },
    { id: "ci-08", storeId: "mumbai-bandra", customerName: "Aisha & Sameer Khan", phone: "+91 98201 55667", purpose: "bridal", outcome: "in_store", repId: "s-201", repName: "Aditya Nair", inH: 11, inM: 15, outH: null },
    { id: "ci-09", storeId: "mumbai-bandra", partyId: "pty-neha", customerName: "Pooja Reddy", phone: "+91 99300 22118", purpose: "browsing", outcome: "follow_up", repId: "s-202", repName: "Fatima Shaikh", inH: 11, inM: 40, outH: 12, outM: 2 },
    { id: "ci-10", storeId: "mumbai-bandra", customerName: "Gautam Malhotra", phone: "+91 98330 71245", purpose: "investment", outcome: "sale_closed", repId: "s-201", repName: "Aditya Nair", inH: 12, inM: 20, outH: 12, outM: 48 },
    { id: "ci-11", storeId: "ahmedabad-cg", customerName: "Ramesh Thakkar", phone: "+91 98980 33421", purpose: "bridal", outcome: "in_store", repId: "s-302", repName: "Harsh Solanki", inH: 10, inM: 55, outH: null },
    { id: "ci-12", storeId: "ahmedabad-cg", customerName: "Krina Doshi", phone: "+91 99240 88190", purpose: "scheme", outcome: "quote_given", repId: "s-302", repName: "Harsh Solanki", inH: 11, inM: 30, outH: 11, outM: 58 },
  ];
  for (const c of checkinDefs) {
    const { id, inH, inM, outH, outM, ...rest } = c;
    const timeIn = at(inH, inM);
    const timeOut = outH != null ? at(outH, outM) : null;
    await prisma.checkIn.upsert({ where: { id }, update: { outcome: c.outcome, timeOut }, create: { id, ...rest, timeIn, timeOut } });
  }

  // ==========================================================================
  // MODULE 8 — TIMELINES: manufacturing orders, production bags, custom-order events
  // ==========================================================================
  const mfgOrders = [
    { id: "mfg-1", storeId: "surat-main", orderNo: "MFG-5001", status: "casting", amount: "498000" },
    { id: "mfg-2", storeId: "mumbai-bandra", orderNo: "MFG-5002", status: "stone_setting", amount: "338000" },
    { id: "mfg-3", storeId: "ahmedabad-cg", orderNo: "MFG-5003", status: "polishing", amount: "322000" },
  ];
  for (const m of mfgOrders) {
    const { id, ...rest } = m;
    await prisma.manufacturingOrder.upsert({ where: { id }, update: {}, create: { id, ...rest, orderDate: daysAgo(14) } });
  }
  const bags = [
    { id: "bag-1", orderId: "mfg-1", bagNo: "REP-501", barcode: "22K finished light-weight chains (24 pcs)", department: "Rajkot Warehouse", status: "in_transit", grossWeight: "312.500", bagDate: daysAgo(0) },
    { id: "bag-2", orderId: "mfg-2", bagNo: "REP-502", barcode: "Loose diamonds VVS (0.30-0.50 ct)", department: "Mumbai HO Vault", status: "dispatched", grossWeight: "0.000", bagDate: daysAgo(0) },
    { id: "bag-3", orderId: "mfg-3", bagNo: "REP-503", barcode: "24K casting grain (replenish stock)", department: "Rajkot Casting Unit", status: "requested", grossWeight: "500.000", bagDate: daysAgo(-3) },
    { id: "bag-4", orderId: "mfg-2", bagNo: "REP-504", barcode: "22K studded pendants (12 pcs)", department: "Rajkot Warehouse", status: "received", grossWeight: "188.200", bagDate: daysAgo(3) },
  ];
  for (const b of bags) {
    const { id, ...rest } = b;
    await prisma.productionBag.upsert({ where: { id }, update: rest, create: { id, ...rest } });
  }
  // Custom-order stage events for the timeline history (co-1..co-5 already seeded).
  const eventDefs = [
    { id: "ev-1", orderId: "co-1", stage: "booked", note: "Order booked, advance collected.", byRole: "salesperson", byName: "Aarav Mehta", off: 12 },
    { id: "ev-2", orderId: "co-1", stage: "designing", note: "CAD design approved by customer.", byRole: "back_office", byName: "Design Studio", off: 8 },
    { id: "ev-3", orderId: "co-3", stage: "booked", note: "Booked at Bandra.", byRole: "salesperson", byName: "Karan Malhotra", off: 9 },
    { id: "ev-4", orderId: "co-3", stage: "casting", note: "Sent to Rajkot casting unit.", byRole: "factory", byName: "Rajkot Casting Unit", off: 6 },
    { id: "ev-5", orderId: "co-3", stage: "stone_setting", note: "Diamonds being set on bench 3.", byRole: "factory", byName: "Setting Bench 3", off: 2 },
    { id: "ev-6", orderId: "co-5", stage: "qc", note: "Final QC in progress.", byRole: "back_office", byName: "QC Desk", off: 1 },
  ];
  for (const e of eventDefs) {
    const { id, off, ...rest } = e;
    await prisma.customOrderEvent.upsert({ where: { id }, update: {}, create: { id, ...rest, occurredAt: daysAgo(off) } });
  }
  // Give custom orders ETAs (some delayed) for the timeline view.
  await prisma.customOrder.update({ where: { id: "co-3" }, data: { eta: daysAgo(-3), ownerRole: "factory", ownerName: "Setting Bench 3" } }).catch(() => {});
  await prisma.customOrder.update({ where: { id: "co-1" }, data: { eta: daysAgo(-11), ownerRole: "factory", ownerName: "Rajkot Casting Unit" } }).catch(() => {});
  await prisma.customOrder.update({ where: { id: "co-5" }, data: { eta: daysAgo(2), ownerRole: "back_office", ownerName: "QC Desk" } }).catch(() => {}); // delayed (eta in past, stage qc)

  // ==========================================================================
  // MODULE 10 — REPORTING/DSR is fully derived; ensure payments exist (Module 12)
  // ==========================================================================
  const paymentDefs = [
    { id: "pay-7001", storeId: "surat-main", partyId: "pty-priya-s", reference: "INV-22841", mode: "upi", amount: "125000", offMin: 0 },
    { id: "pay-7002", storeId: "surat-main", partyId: "pty-priya-s", reference: "INV-22842", mode: "card", amount: "348500", offMin: 0 },
    { id: "pay-7003", storeId: "mumbai-bandra", partyId: "pty-neha", reference: "INV-99120", mode: "cash", amount: "60000", offMin: 0 },
    { id: "pay-7004", storeId: "ahmedabad-cg", partyId: "pty-sanjay", reference: "INV-55012", mode: "net_banking", amount: "712000", offMin: 0 },
    { id: "pay-7005", storeId: "mumbai-bandra", partyId: "pty-neha", reference: "INV-99121", mode: "online", amount: "94000", offMin: 0 },
    { id: "pay-7006", storeId: "ahmedabad-cg", partyId: "pty-sanjay", reference: "INV-55013", mode: "upi", amount: "41800", offMin: 0 },
    { id: "pay-7007", storeId: "surat-main", partyId: "pty-priya-s", reference: "INV-22843", mode: "cash", amount: "22000", offMin: 0 },
    { id: "pay-7008", storeId: "mumbai-bandra", partyId: "pty-neha", reference: "INV-99122", mode: "card", amount: "268000", offMin: 0 },
  ];
  for (const p of paymentDefs) {
    const { id, offMin, ...rest } = p;
    await prisma.payment.upsert({ where: { id }, update: rest, create: { id, ...rest, paidAt: at(11, 0), reconciled: true } });
  }

  // ==========================================================================
  // MODULE 11 — NEW-STORE setup project (checklists, milestones, vendors)
  // ==========================================================================
  const nsProject = await prisma.newStoreProject.upsert({
    where: { id: "ns-pune-kp" },
    update: {},
    create: { id: "ns-pune-kp", name: "Pune — Koregaon Park", city: "Pune", launchDate: new Date("2026-09-15"), leadName: "Rhea Kulkarni" },
  });
  const nsChecklist = [
    { id: "nsc-it-1", department: "it", title: "Lease line + 4G failover provisioned", status: "done" },
    { id: "nsc-it-2", department: "it", title: "POS terminals & billing rack installed", status: "in_progress" },
    { id: "nsc-it-3", department: "it", title: "CCTV & burglar alarm wiring", status: "in_progress" },
    { id: "nsc-it-4", department: "it", title: "Biometric attendance device synced", status: "todo" },
    { id: "nsc-it-5", department: "it", title: "CaratSense terminal onboarding", status: "blocked" },
    { id: "nsc-inv-1", department: "inventory", title: "Opening stock plan (22K/18K mix) approved", status: "done" },
    { id: "nsc-inv-2", department: "inventory", title: "Bridal collection transfer from Mumbai HO", status: "in_progress" },
    { id: "nsc-inv-3", department: "inventory", title: "Hallmarking & BIS tagging of intake", status: "todo" },
    { id: "nsc-inv-4", department: "inventory", title: "Showcase merchandising plan", status: "todo" },
    { id: "nsc-int-1", department: "interiors", title: "Civil work & false ceiling", status: "done" },
    { id: "nsc-int-2", department: "interiors", title: "Display showcases & vault installation", status: "in_progress" },
    { id: "nsc-int-3", department: "interiors", title: "Lighting & gold-tone branding", status: "in_progress" },
    { id: "nsc-int-4", department: "interiors", title: "Signage & facade", status: "todo" },
    { id: "nsc-hr-1", department: "hr", title: "Store manager hired & onboarded", status: "done" },
    { id: "nsc-hr-2", department: "hr", title: "6 sales associates recruited", status: "in_progress" },
    { id: "nsc-hr-3", department: "hr", title: "Product & POS training batch", status: "todo" },
    { id: "nsc-mkt-1", department: "marketing", title: "Launch creative & invites approved", status: "done" },
    { id: "nsc-mkt-2", department: "marketing", title: "Local press & influencer outreach", status: "in_progress" },
    { id: "nsc-mkt-3", department: "marketing", title: "Pre-launch gold-scheme campaign", status: "in_progress" },
    { id: "nsc-mkt-4", department: "marketing", title: "Inauguration event logistics", status: "todo" },
  ];
  for (const c of nsChecklist) {
    const { id, ...rest } = c;
    await prisma.newStoreChecklistItem.upsert({ where: { id }, update: { status: c.status }, create: { id, ...rest, projectId: nsProject.id } });
  }
  const nsMilestones = [
    { id: "nsm-1", marker: "T-90", title: "Foundation locked", summary: "Lease, civil work, and opening-stock plan signed off.", date: new Date("2026-06-17"), state: "complete" },
    { id: "nsm-2", marker: "T-60", title: "Build-out & hiring", summary: "Fit-out, IT install, and 80% staffing in progress.", date: new Date("2026-07-17"), state: "current" },
    { id: "nsm-3", marker: "T-30", title: "Stock & dry-run", summary: "Hallmarked inventory in vault, POS dry-run, staff trained.", date: new Date("2026-08-16"), state: "at_risk" },
    { id: "nsm-4", marker: "Launch", title: "Inauguration", summary: "Muhurat opening with festive campaign live.", date: new Date("2026-09-15"), state: "upcoming" },
  ];
  for (const m of nsMilestones) {
    const { id, ...rest } = m;
    await prisma.newStoreMilestone.upsert({ where: { id }, update: { state: m.state }, create: { id, ...rest, projectId: nsProject.id } });
  }
  const nsVendors = [
    { id: "nsv-1", name: "Shreeji Fixtures Pvt Ltd", task: "Display showcases & strong-room vault", status: "on_track", dueDate: new Date("2026-07-10") },
    { id: "nsv-2", name: "NetSecure Solutions", task: "POS terminals & network rack", status: "at_risk", dueDate: new Date("2026-07-05") },
    { id: "nsv-3", name: "Pixel Signage Co.", task: "Facade signage & gold-tone branding", status: "delayed", dueDate: new Date("2026-08-01") },
    { id: "nsv-4", name: "Celebrations Unlimited", task: "Inauguration event & catering", status: "on_track", dueDate: new Date("2026-09-10") },
    { id: "nsv-5", name: "Assured Assay Centre", task: "Hallmarking & BIS tagging drive", status: "on_track", dueDate: new Date("2026-08-12") },
    { id: "nsv-6", name: "RetailEdge Academy", task: "Staff product & POS training", status: "completed", dueDate: new Date("2026-08-20") },
  ];
  for (const v of nsVendors) {
    const { id, ...rest } = v;
    await prisma.newStoreVendor.upsert({ where: { id }, update: { status: v.status }, create: { id, ...rest, projectId: nsProject.id } });
  }

  // ==========================================================================
  // MODULE 12 — PAYMENTS reconciliation: bank-statement rows (asset/status='bank')
  // narration = "<mode>|<storeReported>" ; amount = bank settlement (0 = pending)
  // ==========================================================================
  const reconRows = [
    { id: "rec-01", storeId: "surat-main", mode: "card", reported: "348500", bank: "348500" },
    { id: "rec-02", storeId: "surat-main", mode: "upi", reported: "166800", bank: "166800" },
    { id: "rec-03", storeId: "mumbai-bandra", mode: "card", reported: "268000", bank: "261560" },
    { id: "rec-04", storeId: "ahmedabad-cg", mode: "net_banking", reported: "712000", bank: "0" },
    { id: "rec-05", storeId: "mumbai-bandra", mode: "cash", reported: "60000", bank: "60000" },
    { id: "rec-06", storeId: "mumbai-bandra", mode: "online", reported: "94000", bank: "94000" },
  ];
  for (const r of reconRows) {
    await prisma.ledgerEntry.upsert({
      where: { id: r.id },
      update: { amount: r.bank, narration: `${r.mode}|${r.reported}` },
      create: { id: r.id, storeId: r.storeId, kind: "asset", side: "debit", status: "bank", amount: r.bank, narration: `${r.mode}|${r.reported}`, entryDate: daysAgo(1) },
    });
  }

  // ==========================================================================
  // MODULE 13 — TICKETING: tickets, messages, recurring patterns
  // ==========================================================================
  const ticketDefs = [
    { id: "tkt-1", ref: "TKT-2061", storeId: "surat-main", subject: "POS terminal freezes during billing rush", category: "it", priority: "urgent", status: "in_progress", assigneeName: "Arjun Rao", reporterName: "Neha (Cashier)", patternTag: "pos-freeze", off: 1,
      messages: [ { body: "Terminal 2 freezes for 30s during peak billing. Customers waiting.", author: "Neha (Cashier)" }, { body: "Auto-routed to IT Helpdesk based on category: IT." }, { body: "Reproduced — RAM spikes on print spooler. Pushing a config fix today.", author: "Arjun Rao" } ] },
    { id: "tkt-2", ref: "TKT-2060", storeId: "mumbai-bandra", subject: "Showcase spotlight flickering in bridal section", category: "maintenance", priority: "medium", status: "routed", assigneeName: "Facilities Desk", reporterName: "Priya (Store Mgr)", patternTag: "display-lighting", off: 1,
      messages: [ { body: "Two spotlights over the bridal showcase flicker. Looks bad to walk-ins.", author: "Priya (Store Mgr)" }, { body: "Auto-routed to Facilities based on category: Maintenance." } ] },
    { id: "tkt-3", ref: "TKT-2058", storeId: "ahmedabad-cg", subject: "Salary slip not generated for May", category: "hr", priority: "high", status: "open", assigneeName: null, reporterName: "Rakesh (Sales)", off: 2,
      messages: [ { body: "My May payslip is missing in the portal.", author: "Rakesh (Sales)" }, { body: "Auto-routed to People Ops based on category: HR." } ] },
    { id: "tkt-4", ref: "TKT-2055", storeId: "surat-main", subject: "Stock transfer from HO delayed 3 days", category: "logistics", priority: "high", status: "in_progress", assigneeName: "Vivek Nair", reporterName: "Sameer (Store Mgr)", off: 3,
      messages: [ { body: "Bridal transfer bag stuck — courier shows no movement.", author: "Sameer (Store Mgr)" }, { body: "Auto-routed to Supply Chain based on category: Logistics." }, { body: "Escalated with courier, expected delivery tomorrow AM.", author: "Vivek Nair" } ] },
    { id: "tkt-5", ref: "TKT-2052", storeId: "mumbai-bandra", subject: "POS terminal freezes when applying discount", category: "it", priority: "high", status: "resolved", assigneeName: "Arjun Rao", reporterName: "Imran (Cashier)", patternTag: "pos-freeze", off: 6,
      messages: [ { body: "App hangs when I apply a discount code at checkout.", author: "Imran (Cashier)" }, { body: "Auto-routed to IT Helpdesk based on category: IT." }, { body: "Patched discount module timeout. Marking resolved.", author: "Arjun Rao" } ] },
    { id: "tkt-6", ref: "TKT-2049", storeId: "ahmedabad-cg", subject: "POS terminal freezes after software update", category: "it", priority: "medium", status: "closed", assigneeName: "Arjun Rao", reporterName: "Deepa (Cashier)", patternTag: "pos-freeze", off: 9,
      messages: [ { body: "After last night's update the terminal freezes on launch.", author: "Deepa (Cashier)" }, { body: "Auto-routed to IT Helpdesk based on category: IT." }, { body: "Rolled back the print driver. Stable now.", author: "Arjun Rao" } ] },
    { id: "tkt-7", ref: "TKT-2047", storeId: "mumbai-bandra", subject: "AC not cooling in customer lounge", category: "maintenance", priority: "low", status: "resolved", assigneeName: "Facilities Desk", reporterName: "Priya (Store Mgr)", patternTag: "display-lighting", off: 10,
      messages: [ { body: "Lounge AC weak, customers uncomfortable.", author: "Priya (Store Mgr)" }, { body: "Auto-routed to Facilities based on category: Maintenance." }, { body: "Gas refilled, filters cleaned.", author: "Facilities Desk" } ] },
  ];
  for (const t of ticketDefs) {
    const { id, off, messages, ...rest } = t;
    await prisma.ticketMessage.deleteMany({ where: { ticketId: id } });
    await prisma.ticket.upsert({ where: { id }, update: rest, create: { id, ...rest, createdAt: daysAgo(off), updatedAt: daysAgo(Math.max(0, off - 1)) } });
    let mi = 0;
    for (const m of messages) {
      await prisma.ticketMessage.create({ data: { id: `${id}-m${mi}`, ticketId: id, body: m.body, authorName: m.author ?? null, createdAt: daysAgo(off) } });
      mi += 1;
    }
  }

  // ==========================================================================
  // MODULE 14 — RETURNS & EXCHANGE: records + intake photos
  // ==========================================================================
  const returnDefs = [
    { id: "rtn-1001", ref: "RTN-2026-1001", storeId: "surat-main", partyId: "pty-priya-s", customerName: "Priya Sharma", phone: "+91 98250 11223", type: "old_gold", item: "Old 22K bangles (2 pcs)", value: String(Math.round(38.42 * 6580 - 4100)), weightGrams: "38.420", settlement: "exchange", status: "approved", reason: "Trade-in towards new bridal set", raisedBy: "Aarav Mehta", off: 1,
      photos: [ { label: "Front view" }, { label: "On weighing scale" } ] },
    { id: "rtn-1002", ref: "RTN-2026-1002", storeId: "surat-main", customerName: "Rahul Desai", phone: "+91 99099 44556", type: "return", item: "18K Diamond pendant — DP-4471", value: "84500", settlement: "refund", status: "pending_approval", reason: "Size/clasp defect reported within 7 days", raisedBy: "Neha Kulkarni", off: 1,
      photos: [ { label: "Front view" }, { label: "Damage / wear" } ] },
    { id: "rtn-1003", ref: "RTN-2026-1003", storeId: "mumbai-bandra", partyId: "pty-neha", customerName: "Fatima Khan", phone: "+91 98191 77889", type: "exchange", item: "22K Gold chain — upgrade to heavier piece", value: String(Math.round(21.1 * 6580 - 2200)), weightGrams: "21.100", settlement: "exchange", status: "settled", reason: "Design upgrade", raisedBy: "Imran Shaikh", off: 3,
      photos: [ { label: "Front view" }, { label: "Back / hallmark" } ] },
    { id: "rtn-1004", ref: "RTN-2026-1004", storeId: "ahmedabad-cg", customerName: "Sneha Patel", phone: "+91 97250 33445", type: "repair", item: "22K Jhumka — broken hook", value: "0", settlement: "credit_note", status: "draft", reason: "Repair estimate; awaiting customer approval", raisedBy: "Aarav Mehta", off: 0,
      photos: [ { label: "Damage / wear" } ] },
    { id: "rtn-1005", ref: "RTN-2026-1005", storeId: "surat-main", customerName: "Vikram Joshi", phone: "+91 98980 22110", type: "return", item: "Silver gift article — SG-220", value: "6400", settlement: "refund", status: "rejected", reason: "Returned after 30-day window — declined", raisedBy: "Neha Kulkarni", off: 5, photos: [] },
  ];
  for (const r of returnDefs) {
    const { id, off, photos, ...rest } = r;
    await prisma.returnPhoto.deleteMany({ where: { returnId: id } });
    await prisma.returnRecord.upsert({ where: { id }, update: { status: r.status }, create: { id, ...rest, createdAt: daysAgo(off) } });
    let pi = 0;
    for (const p of photos) {
      await prisma.returnPhoto.create({ data: { id: `${id}-p${pi}`, returnId: id, url: `https://cdn.caratsense.in/returns/${id}-${pi}.jpg`, label: p.label } });
      pi += 1;
    }
  }

  // Module 14 — HO-set diamond rate table (per-carat, by spec/code) for the
  // exchange/buyback calculator. Idempotent by stable id; effectiveFrom = now.
  const diamondRateDefs = [
    { id: "dr-1ct", spec: "1ct", ratePerCarat: "55000" },
    { id: "dr-2ct", spec: "2ct", ratePerCarat: "90000" },
    { id: "dr-20cent", spec: "20cent", ratePerCarat: "18000" },
  ];
  for (const dr of diamondRateDefs) {
    const { id, ...rest } = dr;
    await prisma.diamondRate.upsert({
      where: { id },
      update: { ratePerCarat: rest.ratePerCarat, effectiveFrom: new Date() },
      create: { id, ...rest, effectiveFrom: new Date() },
    });
  }

  // ==========================================================================
  // MODULE 16 — MARKETING: campaigns, target stores, assets
  // ==========================================================================
  const ALL3 = ["surat-main", "mumbai-bandra", "ahmedabad-cg"];
  const campaignDefs = [
    { id: "c-bridal-26", name: "Eternal Vows — Bridal '26", type: "bridal", status: "live", start: "2026-05-15", end: "2026-08-31", budget: "8500000", spend: "4120000", ownerName: "Ananya Iyer", agency: "Lotus Creative", stores: ALL3,
      assets: [ { id: "as-1", title: "bridal_hero_v3.mp4", status: "changes_requested", dueDate: "2026-06-22" }, { id: "as-2", title: "necklace_carousel_01-09.zip", status: "submitted", dueDate: "2026-06-19" }, { id: "as-3", title: "whatsapp_pack_final.zip", status: "approved", dueDate: "2026-06-16" } ] },
    { id: "c-akshaya", name: "Akshaya Tritiya Gold Rush", type: "festive", status: "completed", start: "2026-04-20", end: "2026-05-05", budget: "3200000", spend: "3075000", ownerName: "Karan Malhotra", agency: "Lotus Creative", stores: ["surat-main", "mumbai-bandra"], assets: [] },
    { id: "c-dhanteras", name: "Dhanteras Festive Drop", type: "festive", status: "planning", start: "2026-10-25", end: "2026-11-12", budget: "6000000", spend: "0", ownerName: "Karan Malhotra", agency: "Pixel & Print", stores: ALL3,
      assets: [ { id: "as-5", title: "dhanteras_keyline_copy.docx", status: "pending", dueDate: "2026-07-15" } ] },
    { id: "c-catalog-aw", name: "Autumn/Winter Catalog Drop", type: "catalog", status: "in_review", start: "2026-07-01", end: "2026-07-20", budget: "1800000", spend: "640000", ownerName: "Ananya Iyer", agency: "Pixel & Print", stores: ["mumbai-bandra", "ahmedabad-cg"],
      assets: [ { id: "as-4", title: "aw_catalog_proof.pdf", status: "in_progress", dueDate: "2026-06-28" } ] },
    { id: "c-always", name: "Gold Scheme Always-On", type: "always_on", status: "live", start: "2026-01-01", end: "2026-12-31", budget: "2400000", spend: "1190000", ownerName: "Ananya Iyer", agency: "In-house", stores: ALL3, assets: [] },
  ];
  for (const c of campaignDefs) {
    const { id, stores, assets, start, end, ...rest } = c;
    await prisma.campaignStore.deleteMany({ where: { campaignId: id } });
    await prisma.marketingAsset.deleteMany({ where: { campaignId: id } });
    await prisma.marketingCampaign.upsert({ where: { id }, update: rest, create: { id, ...rest, startDate: new Date(start), endDate: new Date(end) } });
    for (const sid of stores) await prisma.campaignStore.create({ data: { campaignId: id, storeId: sid } });
    for (const a of assets) await prisma.marketingAsset.create({ data: { id: a.id, campaignId: id, title: a.title, status: a.status, dueDate: new Date(a.dueDate) } });
  }

  // ==========================================================================
  // MODULE 17 — "Earn with Éclat" referral / commission program
  // ==========================================================================
  await prisma.referralCode.upsert({
    where: {
      organisationId_code: {
        organisationId: ORGANISATION_ID,
        code: "ECLAT-DEMO",
      },
    },
    update: { maxUses: 10 },
    create: {
      id: "ref-code-demo",
      code: "ECLAT-DEMO",
      referrerName: "Demo Referrer",
      referrerPhone: "+91 90000 12345",
      storeId: "surat-main",
      maxUses: 10,
    },
  });

  // ==========================================================================
  // MODULE 10 — Daily Sales Report (DSR): the exact store-close report a manager
  // types on WhatsApp, captured on the website. Demo = the owner's Udaipur example
  // (storeId points at an existing seeded store so it shows on the cloud).
  // ==========================================================================
  await prisma.dailyReport.upsert({
    where: { id: "dsr-demo-udaipur" },
    update: {},
    create: {
      id: "dsr-demo-udaipur",
      storeId: "surat-main",
      reportDate: new Date("2026-06-24T00:00:00.000Z"),
      reportTime: "8:00 PM",
      walkIns: 2,
      seriousEnquiries: 1,
      deliveredBilled: "55000",
      bookingsNew: "80000",
      advanceReceived: "10000",
      cash: "65000",
      card: "0",
      upi: "0",
      oldGoldWtG: null,
      oldGoldValue: null,
      submittedBy: "Manish Vaishnav",
    },
  });

  const modules = await seedModules(prisma);

  console.log("Seed complete:");
  console.log(`  ${userDefs.length} users (password: ${PASSWORD}), ${storeDefs.length} stores + 1 aggregate`);
  console.log(`  ${products.length} products, ${stock.length} stock items, ${leads.length} leads, ${quoteDefs.length} quotes`);
  console.log(`  sales across 7 days, footfall check-ins, ${customOrders.length} custom orders, 2 discount requests`);
  console.log(`  Module 6: 2 shifts + week-off + holiday on Mumbai — Bandra, late-flag demo (Fatima 3x -> flagged)`);
  // Counted by the writer, not typed here: the old line claimed two scheme
  // members this seed had never created, and nobody noticed for months.
  for (const [what, n] of Object.entries(modules)) console.log(`  ${n} ${what}`);
}

main()
  .then(() => basePrisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await basePrisma.$disconnect();
    process.exit(1);
  });
