// Standalone, idempotent seed for the Module 14 diamond rate table.
// Mirrors the diamond-rate block in seed.mjs so the exchange/buyback calculator
// is demoable without re-running the full seed. Run: node prisma/seed-diamond-rates.mjs
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const diamondRateDefs = [
  { id: "dr-1ct", spec: "1ct", ratePerCarat: "55000" },
  { id: "dr-2ct", spec: "2ct", ratePerCarat: "90000" },
  { id: "dr-20cent", spec: "20cent", ratePerCarat: "18000" },
];

async function main() {
  for (const dr of diamondRateDefs) {
    const { id, ...rest } = dr;
    await prisma.diamondRate.upsert({
      where: { id },
      update: { ratePerCarat: rest.ratePerCarat, effectiveFrom: new Date() },
      create: { id, ...rest, effectiveFrom: new Date() },
    });
  }
  const rows = await prisma.diamondRate.findMany({ orderBy: { spec: "asc" } });
  console.log(
    "Diamond rates:",
    rows.map((r) => `${r.spec}=${r.ratePerCarat}`).join(", "),
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
