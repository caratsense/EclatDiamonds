import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const r = {};
r.partyLegacy = await prisma.party.count({ where: { legacyId: { not: null } } });
r.partyTotal = await prisma.party.count();
r.productLegacy = await prisma.product.count({ where: { legacyId: { not: null } } });
r.stockLegacy = await prisma.stockItem.count({ where: { legacyId: { not: null } } });
r.stockSold = await prisma.stockItem.count({ where: { legacyId: { not: null }, status: "sold" } });
r.saleLegacy = await prisma.sale.count({ where: { legacyId: { not: null } } });
r.saleByType = await prisma.sale.groupBy({
  by: ["docType"], where: { legacyId: { not: null } }, _count: true,
});
r.saleLineLegacy = await prisma.saleLine.count({ where: { legacyId: { not: null } } });
r.mfgLegacy = await prisma.manufacturingOrder.count({ where: { legacyId: { not: null } } });
r.mfgItemLegacy = await prisma.manufacturingOrderItem.count({ where: { legacyId: { not: null } } });

// spot checks
const topSale = await prisma.sale.findFirst({
  where: { legacyId: { not: null } },
  orderBy: { totalAmount: "desc" },
  select: { docNo: true, docType: true, totalAmount: true, party: { select: { name: true } } },
});
const sampleStock = await prisma.stockItem.findFirst({
  where: { legacyId: { not: null }, diamondWeightCt: { gt: 0 } },
  select: { sku: true, metal: true, grossWeight: true, netWeight: true, diamondWeightCt: true, mrp: true },
});

console.log(JSON.stringify(r, null, 2));
console.log("\nTop sale by amount:", JSON.stringify(topSale));
console.log("Sample diamond stock item:", JSON.stringify(sampleStock));

await prisma.$disconnect();
