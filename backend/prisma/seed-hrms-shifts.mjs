// Standalone, idempotent seed for the Module 6 (HRMS) shifts / batches, week-off,
// holidays and late-flag demo. Mirrors the Module 6 block in seed.mjs so the
// shift + late-flag features are demoable without re-running the full seed
// (which is not cross-day idempotent for the legacy attendance block).
// Run: node prisma/seed-hrms-shifts.mjs
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const today = new Date();

async function main() {
  // Mumbai — Bandra is a mall store: 2 shifts + a weekly off day (2 = Tuesday).
  await prisma.store.update({ where: { id: "mumbai-bandra" }, data: { weekOffDay: 2 } });

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
      create: { id, ...rest },
    });
  }

  // Late-flag demo (FLAG ONLY, no salary math). Fatima (s-202) late on 3 mornings
  // this month -> flagged; Aditya (s-201) late once -> not flagged. UTC dates so
  // month-grouping is boundary-safe; lateness measured vs the Morning shift.
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
      create: { id, date, ...base, ...rest },
    });
  }

  const shifts = await prisma.shift.findMany({ where: { storeId: "mumbai-bandra" }, orderBy: { startTime: "asc" } });
  const store = await prisma.store.findUnique({ where: { id: "mumbai-bandra" }, select: { name: true, weekOffDay: true } });
  console.log("Shifts:", shifts.map((s) => `${s.name} ${s.startTime}-${s.endTime} buf${s.bufferMins}${s.isNightBatch ? " (night)" : ""}`).join(", "));
  console.log(`Week-off: ${store.name} -> weekOffDay=${store.weekOffDay}`);
  console.log("Late-flag demo rows seeded for s-202 (x3) + s-201 (x1) this month.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
