// Set NewStoreProject.regionId for existing rows (OP-4 region scoping).
// Maps a project to the region of a store in the same city; falls back to the
// first region so area managers still see demo launches. RUN from backend/.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const firstRegion = await prisma.region.findFirst({ orderBy: { name: "asc" } });
const projects = await prisma.newStoreProject.findMany();
let updated = 0;
for (const p of projects) {
  if (p.regionId) continue;
  const cityKey = (p.city || "").split("—")[0].trim();
  const store = cityKey
    ? await prisma.store.findFirst({ where: { city: { contains: cityKey } }, select: { regionId: true } })
    : null;
  const regionId = store?.regionId ?? firstRegion?.id ?? null;
  if (regionId) {
    await prisma.newStoreProject.update({ where: { id: p.id }, data: { regionId } });
    updated++;
  }
}
console.log(`Set regionId on ${updated}/${projects.length} new-store projects`);
await prisma.$disconnect();
