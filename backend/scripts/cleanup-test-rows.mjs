// Remove the throwaway rows created while verifying the Phase-2 create endpoints.
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const r = {};
r.products = (await p.product.deleteMany({ where: { sku: { startsWith: "TEST-SKU-VERIFY" } } })).count;
r.stock = (await p.stockItem.deleteMany({ where: { sku: { startsWith: "TEST-STK-VERIFY" } } })).count;
r.payments = (await p.payment.deleteMany({ where: { reference: { startsWith: "TEST-PAY-VERIFY" } } })).count;
r.campaigns = (await p.marketingCampaign.deleteMany({ where: { name: "Test Festive Drive" } })).count;
r.ledger = (await p.ledgerEntry.deleteMany({ where: { narration: "Test receivable" } })).count;
console.log("Deleted test rows:", JSON.stringify(r));
await p.$disconnect();
