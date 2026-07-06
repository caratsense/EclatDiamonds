// ============================================================================
// Eclat / CaratSense — one-time legacy backfill (APRS-SJEP -> eclat_dev)
// ----------------------------------------------------------------------------
// Reads core entities from the RESTORED legacy SQL Server copy and upserts them
// into the Eclat Postgres dev DB, mapping legacy -> Eclat per docs/eclat-schema.md:
//
//   PartyMst        -> Party        (legacyId = PartyNo)
//   StyleMst(+Sum)  -> Product      (legacyId = StyleId)
//   Inward(+Summary)-> StockItem    (legacyId = JewelId)
//   JewelTrans      -> Sale         (legacyId = JewelTransId)
//   JewelTransInward(+Summary) -> SaleLine  (legacyId = "<JewelTransId>:<JewelId>:<SrNo>")
//   Spm_MfgOrder    -> ManufacturingOrder      (legacyId = OrderId)
//   SPM_MfgOrderItem-> ManufacturingOrderItem  (legacyId = OrderItemId)
//
// IDEMPOTENT: every row is upserted on its unique `legacyId`, so re-running ADDS
// nothing new and only refreshes legacy-sourced rows. The existing demo seed
// (rows WITHOUT legacyId) is never touched or deleted.
//
// Everything attaches to the seeded store `surat-main` (the legacy backup is a
// single-branch fresh install; no clean legacy branch -> store mapping exists).
//
// SOURCE  : APRSSJEP_eclat on localhost\SQLEXPRESS (restored throwaway copy, READ-ONLY)
// TARGET  : postgresql://postgres:postgres@localhost:5432/eclat_dev (Prisma)
// RUN     : node scripts/backfill-legacy.mjs       (from backend/)
//
// CONNECTION NOTE: this local SQLEXPRESS has TCP/IP DISABLED (shared-memory /
// named-pipes only) and SQL Browser stopped, so the tedious-based `mssql` npm
// driver cannot reach it without reconfiguring the service (which we must not do
// — originals are read-only). We therefore read the legacy DB through the working
// `Invoke-Sqlcmd` path (SqlServer PowerShell module) as a child process that
// returns JSON. The `mssql` package remains a dependency for the PRODUCTION live
// sync, where the client's server has TCP enabled. To use mssql directly instead,
// set SJEP_USE_MSSQL=1 (requires TCP + a host:port or SQL Browser).
// ============================================================================

import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";

const prisma = new PrismaClient();

const SQL_SERVER = "localhost\\SQLEXPRESS";
const SQL_DB = "APRSSJEP_eclat";
const SQLSERVER_MODULE =
  "C:\\Users\\Shrey\\Documents\\WindowsPowerShell\\Modules\\SqlServer\\22.4.5.1\\SqlServer.psd1";

// Read-only legacy query via Invoke-Sqlcmd, returned as an array of row objects.
function query(tsql) {
  const ps = [
    `Import-Module '${SQLSERVER_MODULE}' -Force`,
    `$r = Invoke-Sqlcmd -ServerInstance '${SQL_SERVER}' -TrustServerCertificate ` +
      `-Database '${SQL_DB}' -MaxCharLength 100000 -QueryTimeout 0 -Query @'\n${tsql}\n'@`,
    // Force array, drop PS metadata columns, emit JSON.
    `$r = @($r) | Select-Object * -ExcludeProperty ItemArray,Table,RowError,RowState,HasErrors`,
    `$r | ConvertTo-Json -Depth 3 -Compress`,
  ].join(";\n");
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" },
  );
  const txt = out.trim();
  if (!txt) return [];
  const parsed = JSON.parse(txt);
  return Array.isArray(parsed) ? parsed : [parsed];
}

const STORE_ID = "surat-main";

// ── value coercion helpers ───────────────────────────────────────────────────
const dec = (v) => (v === null || v === undefined ? null : v.toString());
const int = (v) => (v === null || v === undefined ? null : Math.trunc(Number(v)));
const str = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
};
const dt = (v) => {
  if (v === null || v === undefined || v === "") return null;
  // PowerShell ConvertTo-Json renders DateTime as "/Date(<ms>)/".
  if (typeof v === "string") {
    const m = v.match(/\/Date\((-?\d+)\)\//);
    if (m) v = Number(m[1]);
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
};
const bool = (v) => v === true || v === 1 || v === "1";

// ── legacy ToneFor (G=gold, D=diamond) + StyleFor -> Eclat MetalKind ──────────
function metalFromTone(toneFor, toneCode) {
  const c = (toneCode || "").toUpperCase();
  if (c.includes("PG") || c.includes("PINK") || c.includes("ROSE")) return "rose_gold_18k";
  // Legacy doesn't store karat on the tone; default gold pieces to 22k (dominant
  // retail purity in this market). Karat refinement needs the live RateChart join.
  if ((toneFor || "").toUpperCase() === "G") return "gold_22k";
  return "gold_22k";
}
function karatFromMetal(metal) {
  return { gold_24k: 24, gold_22k: 22, gold_18k: 18, rose_gold_18k: 18, platinum: 0, silver: 0 }[metal] ?? 0;
}

// ── legacy JewelTrans.TranType -> Eclat SaleDocType ───────────────────────────
// JWSL=sale, JWPH=purchase, JWBAP/JWBAI/BJW*=branch transfer, JWPRM=proforma.
function docTypeFromTranType(tt) {
  const t = (tt || "").toUpperCase();
  if (t === "JWSL" || t === "BJWSL") return "sale";
  if (t === "JWPH" || t === "BJWPH") return "purchase";
  if (t === "JWPRM") return "proforma";
  if (t.includes("BA")) return "branch_transfer"; // JWBAP / JWBAI
  return "sale";
}

// ── legacy Inward.Status / InwardType -> Eclat StockStatus ───────────────────
function stockStatusFromInward(row) {
  if (row.SaleId) return "sold";
  return "in_stock";
}

async function run() {
  console.log("Reading legacy SQL Server (APRSSJEP_eclat) via Invoke-Sqlcmd...");
  console.log("Verifying target store...");

  const store = await prisma.store.findUnique({ where: { id: STORE_ID } });
  if (!store) throw new Error(`Target store '${STORE_ID}' not found — run the seed first.`);

  const counts = {};

  // ── 1. PartyMst -> Party ───────────────────────────────────────────────────
  console.log("\n[1/6] Parties (PartyMst -> Party)...");
  const parties = query((`
    SELECT PartyNo, FirmName, LegalName, PartyCode,
           IsCustomer, IsSupplier, IsSalesMan, IsFactory, IsLocation, IsAccount, IsBlackList,
           FirmAdd1, FirmAdd2, FirmCity, FirmState, FirmCountry, FirmPinCode,
           FirmEmail, FirmTele, OwnerMobile, WhatsAppNo,
           AccGst, FirmPan, AadhaarNo, CreditLimit,
           FirmBirthDate, FirmAnniversaryDate, UpdateDate
    FROM PartyMst`));

  const partyIdByLegacy = new Map();
  let pc = 0;
  for (const r of parties) {
    const types = [];
    if (bool(r.IsCustomer)) types.push("customer");
    if (bool(r.IsSupplier)) types.push("supplier");
    if (bool(r.IsSalesMan)) types.push("salesperson");
    if (bool(r.IsLocation) || bool(r.IsFactory)) types.push("branch");
    if (bool(r.IsAccount)) types.push("account");

    const data = {
      storeId: STORE_ID,
      name: str(r.FirmName) || str(r.LegalName) || str(r.PartyCode) || r.PartyNo,
      legalName: str(r.LegalName),
      code: str(r.PartyCode),
      types,
      phone: str(r.FirmTele) || str(r.OwnerMobile),
      whatsapp: str(r.WhatsAppNo),
      email: str(r.FirmEmail),
      addressLine1: str(r.FirmAdd1),
      addressLine2: str(r.FirmAdd2),
      city: str(r.FirmCity),
      state: str(r.FirmState),
      country: str(r.FirmCountry) || "India",
      pincode: str(r.FirmPinCode),
      gstin: str(r.AccGst),
      pan: str(r.FirmPan),
      aadhaar: str(r.AadhaarNo),
      birthday: dt(r.FirmBirthDate),
      anniversary: dt(r.FirmAnniversaryDate),
      creditLimit: dec(r.CreditLimit),
      isBlacklisted: bool(r.IsBlackList),
      legacyUpdatedAt: dt(r.UpdateDate),
    };
    const p = await prisma.party.upsert({
      where: { legacyId: r.PartyNo },
      create: { legacyId: r.PartyNo, ...data },
      update: data,
    });
    partyIdByLegacy.set(r.PartyNo, p.id);
    pc++;
  }
  counts.Party = pc;
  console.log(`  upserted ${pc} parties`);

  // ── 2. StyleMst (+Summary) -> Product ──────────────────────────────────────
  console.log("\n[2/6] Products (StyleMst -> Product)...");
  const styles = query((`
    SELECT t.StyleId, t.StyleCode, t.StyleSKUNo, t.ModelWt, t.WaxWt,
           t.TagPrice, t.EndClientPrice, t.BestSeller, t.WebDescription,
           tone.ToneFor, tone.ToneCode,
           s.GrossWt, s.NetWt, s.TotDiaWt, s.TotDiaPc, s.MRP
    FROM StyleMst t
    LEFT JOIN StyleMstSummary s ON s.StyleId = t.StyleId
    LEFT JOIN ToneMst tone      ON tone.ToneNo = t.MetalToneNo`));

  const productIdByStyle = new Map();
  let sc = 0;
  for (const r of styles) {
    const metal = metalFromTone(r.ToneFor, r.ToneCode);
    const sku = str(r.StyleSKUNo) || str(r.StyleCode) || `STYLE-${r.StyleId}`;
    const data = {
      storeId: STORE_ID,
      sku,
      name: str(r.StyleCode) || sku,
      metal,
      karat: karatFromMetal(metal),
      weightGrams: dec(r.GrossWt ?? r.ModelWt) ?? "0",
      caratWeight: dec(r.TotDiaWt) ?? "0",
      price: dec(r.MRP ?? r.TagPrice ?? r.EndClientPrice) ?? "0",
      description: str(r.WebDescription),
      bestSeller: bool(r.BestSeller),
    };
    const prod = await prisma.product.upsert({
      where: { legacyId: String(r.StyleId) },
      create: { legacyId: String(r.StyleId), ...data },
      update: data,
    });
    productIdByStyle.set(Number(r.StyleId), prod.id);
    sc++;
  }
  counts.Product = sc;
  console.log(`  upserted ${sc} products`);

  // ── 3. Inward (+Summary) -> StockItem ──────────────────────────────────────
  console.log("\n[3/6] Stock items (Inward -> StockItem)...");
  const inward = query((`
    SELECT t.JewelId, t.JewelCode, t.InwardSKUNo, t.StyleId,
           t.InwardDate, t.InwardType, t.Status, t.SaleId,
           t.TagPrice, t.Jewelry_CertificateNo, t.HallMarkId,
           tone.ToneFor, tone.ToneCode,
           s.GrossWt, s.NetWt, s.PureWt, s.MetalLossWt,
           s.TotDiaWt, s.TotDiaPc, s.TotCZWt,
           s.TotMtlAmt, s.TotDiaAmt, s.TotCZAmt, s.TotHandlingAmt, s.TotCPFAmt,
           s.COST, s.MRP, t.UpdateDate
    FROM Inward t
    LEFT JOIN InwardSummary s ON s.JewelId = t.JewelId
    LEFT JOIN ToneMst tone    ON tone.ToneNo = t.MetalToneNo`));

  let ic = 0;
  for (const r of inward) {
    const metal = metalFromTone(r.ToneFor, r.ToneCode);
    const productId = productIdByStyle.get(Number(r.StyleId)) ?? null;
    const data = {
      storeId: STORE_ID,
      productId,
      sku: str(r.InwardSKUNo) || str(r.JewelCode),
      name: str(r.JewelCode),
      metal,
      karat: karatFromMetal(metal),
      status: stockStatusFromInward(r),
      grossWeight: dec(r.GrossWt),
      netWeight: dec(r.NetWt),
      pureWeight: dec(r.PureWt),
      metalLossWeight: dec(r.MetalLossWt),
      diamondWeightCt: dec(r.TotDiaWt),
      diamondPieces: int(r.TotDiaPc),
      stoneWeightCt: dec(r.TotCZWt),
      metalAmount: dec(r.TotMtlAmt),
      diamondAmount: dec(r.TotDiaAmt),
      stoneAmount: dec(r.TotCZAmt),
      makingAmount: dec(r.TotHandlingAmt),
      cpfAmount: dec(r.TotCPFAmt),
      cost: dec(r.COST),
      mrp: dec(r.MRP),
      tagPrice: dec(r.TagPrice),
      hallmarkNo: str(r.HallMarkId),
      certificateNo: str(r.Jewelry_CertificateNo),
      inwardDate: dt(r.InwardDate),
      legacyUpdatedAt: dt(r.UpdateDate),
    };
    await prisma.stockItem.upsert({
      where: { legacyId: String(r.JewelId) },
      create: { legacyId: String(r.JewelId), ...data },
      update: data,
    });
    ic++;
  }
  counts.StockItem = ic;
  console.log(`  upserted ${ic} stock items`);

  // ── 4. JewelTrans -> Sale ──────────────────────────────────────────────────
  console.log("\n[4/6] Sales (JewelTrans -> Sale)...");
  const sales = query((`
    SELECT JewelTransId, JewelTransPrefix, JewelTransNo, JewelTransDate, TranType,
           PartyNo, Amount, GrossAmount, TotalAddlessAmount, Remarks, isCancel, UpdateDate
    FROM JewelTrans`));

  const saleIdByLegacy = new Map();
  let salec = 0;
  for (const r of sales) {
    const docType = docTypeFromTranType(r.TranType);
    // Legacy doc numbers repeat across books/series, but the Eclat Sale has a
    // @@unique([storeId, docNo, docType]). Suffix with JewelTransId to guarantee
    // uniqueness while keeping the human-readable prefix+number visible.
    const baseNo = `${str(r.JewelTransPrefix) || ""}${r.JewelTransNo ?? r.JewelTransId}`;
    const docNo = `${baseNo}#${r.JewelTransId}`;
    const data = {
      storeId: STORE_ID,
      partyId: partyIdByLegacy.get(r.PartyNo) ?? null,
      docNo,
      docType,
      docDate: dt(r.JewelTransDate) || new Date(),
      grossAmount: dec(r.GrossAmount) ?? "0",
      totalAmount: dec(r.Amount) ?? "0",
      remarks: str(r.Remarks),
      isCancelled: bool(r.isCancel),
      legacyUpdatedAt: dt(r.UpdateDate),
    };
    const sale = await prisma.sale.upsert({
      where: { legacyId: String(r.JewelTransId) },
      create: { legacyId: String(r.JewelTransId), ...data },
      update: data,
    });
    saleIdByLegacy.set(Number(r.JewelTransId), sale.id);
    salec++;
  }
  counts.Sale = salec;
  console.log(`  upserted ${salec} sales`);

  // ── 4b. JewelTransInward (+Summary) -> SaleLine ────────────────────────────
  console.log("\n[4b/6] Sale lines (JewelTransInward -> SaleLine)...");
  const lines = query((`
    SELECT l.JewelTransId, l.JewelId, l.SrNo, l.MRP, l.DiscountAmt,
           s.NetWt, s.TotMtlAmt, s.TotHandlingAmt, s.TotDiaAmt, s.TotLossAmt
    FROM JewelTransInward l
    LEFT JOIN JewelTransInwardSummary s
           ON s.JewelTransId = l.JewelTransId AND s.JewelId = l.JewelId`));

  // resolve stockItem ids for the JewelIds referenced by lines
  const stockByLegacy = new Map();
  const jewelIds = [...new Set(lines.map((l) => String(l.JewelId)))];
  for (let i = 0; i < jewelIds.length; i += 500) {
    const chunk = jewelIds.slice(i, i + 500);
    const found = await prisma.stockItem.findMany({
      where: { legacyId: { in: chunk } },
      select: { id: true, legacyId: true },
    });
    for (const f of found) stockByLegacy.set(f.legacyId, f.id);
  }

  let lc = 0;
  for (const r of lines) {
    const saleId = saleIdByLegacy.get(Number(r.JewelTransId));
    if (!saleId) continue; // line for a non-imported / cancelled header
    const legacyId = `${r.JewelTransId}:${r.JewelId}:${r.SrNo ?? 0}`;
    const data = {
      saleId,
      stockItemId: stockByLegacy.get(String(r.JewelId)) ?? null,
      netWeight: dec(r.NetWt),
      metalAmount: dec(r.TotMtlAmt),
      makingAmount: dec(r.TotHandlingAmt),
      stoneAmount: dec(r.TotDiaAmt),
      discountAmount: dec(r.DiscountAmt),
      lineTotal: dec(r.MRP) ?? "0",
    };
    await prisma.saleLine.upsert({
      where: { legacyId },
      create: { legacyId, ...data },
      update: data,
    });
    lc++;
  }
  counts.SaleLine = lc;
  console.log(`  upserted ${lc} sale lines`);

  // ── 5. Spm_MfgOrder -> ManufacturingOrder ──────────────────────────────────
  console.log("\n[5/6] Manufacturing orders (Spm_MfgOrder -> ManufacturingOrder)...");
  const orders = query((`
    SELECT OrderId, OrderPrefix, OrderNo, OrderDate, CustomerId, MadeFor_PartyNo,
           OrderStatus, Amount, GrossAmount, PoNo, UpdateDate
    FROM Spm_MfgOrder`));

  const orderIdByLegacy = new Map();
  let oc = 0;
  for (const r of orders) {
    const partyId =
      partyIdByLegacy.get(r.MadeFor_PartyNo) ?? partyIdByLegacy.get(r.CustomerId) ?? null;
    const data = {
      storeId: STORE_ID,
      partyId,
      orderNo: `${str(r.OrderPrefix) || ""}${r.OrderNo ?? r.OrderId}`,
      orderDate: dt(r.OrderDate) || new Date(),
      // Legacy OrderStatus is an int code (decode TBD) — map all to "booked" for now.
      status: "booked",
      amount: dec(r.Amount ?? r.GrossAmount) ?? "0",
      poNo: str(r.PoNo),
      legacyUpdatedAt: dt(r.UpdateDate),
    };
    const ord = await prisma.manufacturingOrder.upsert({
      where: { legacyId: String(r.OrderId) },
      create: { legacyId: String(r.OrderId), ...data },
      update: data,
    });
    orderIdByLegacy.set(Number(r.OrderId), ord.id);
    oc++;
  }
  counts.ManufacturingOrder = oc;
  console.log(`  upserted ${oc} manufacturing orders`);

  // ── 6. SPM_MfgOrderItem -> ManufacturingOrderItem ──────────────────────────
  console.log("\n[6/6] Manufacturing order items (SPM_MfgOrderItem -> ManufacturingOrderItem)...");
  const oitems = query((`
    SELECT OrderItemId, OrderId, SKUNo, OrderQty, ExpDelDate, Completed,
           Inward_JewelId, SpecialRemarks
    FROM SPM_MfgOrderItem`));

  let oic = 0;
  for (const r of oitems) {
    const orderId = orderIdByLegacy.get(Number(r.OrderId));
    if (!orderId) continue;
    const data = {
      orderId,
      styleSku: str(r.SKUNo),
      description: str(r.SpecialRemarks),
      orderQty: int(r.OrderQty) ?? 1,
      status: bool(r.Completed) ? "ready" : "booked",
      expectedDelivery: dt(r.ExpDelDate),
      producedStockItemId: r.Inward_JewelId
        ? stockByLegacy.get(String(r.Inward_JewelId)) ?? null
        : null,
    };
    await prisma.manufacturingOrderItem.upsert({
      where: { legacyId: String(r.OrderItemId) },
      create: { legacyId: String(r.OrderItemId), ...data },
      update: data,
    });
    oic++;
  }
  counts.ManufacturingOrderItem = oic;
  console.log(`  upserted ${oic} manufacturing order items`);


  console.log("\n==================== BACKFILL COMPLETE ====================");
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(24)} ${v}`);
  console.log("===========================================================");
  return counts;
}

run()
  .catch((e) => {
    console.error("\nBACKFILL FAILED:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
