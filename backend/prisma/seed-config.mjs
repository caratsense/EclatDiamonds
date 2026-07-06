// Idempotent CONFIG seed — safe to run on every deploy (via railway preDeployCommand).
// Seeds the lookup/config data the new modules need so cloud pages aren't empty:
//   discount caps (M15) · diamond rates (M14) · a demo shift set + week-off (M6)
//   · product cost prices (M15 margin) · a demo referral code (M17).
// Uses find-or-create everywhere (no reliance on nullable-column unique upserts),
// so re-running never duplicates. Never deletes. Never touches synced business rows.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function firstStoreId() {
  const s =
    (await prisma.store.findFirst({ where: { isAggregate: false }, select: { id: true } })) ??
    (await prisma.store.findFirst({ select: { id: true } }));
  return s?.id ?? null;
}

async function seedDiscountCaps() {
  const caps = [
    { role: 'salesperson', maxDiamondPercent: 2, maxMakingPercent: 5, maxPercent: 2 },
    { role: 'store_manager', maxDiamondPercent: 5, maxMakingPercent: 10, maxPercent: 10 },
    { role: 'area_manager', maxDiamondPercent: 20, maxMakingPercent: 20, maxPercent: 20 },
    { role: 'head_office', maxDiamondPercent: 100, maxMakingPercent: 100, maxPercent: 100 },
  ];
  let n = 0;
  for (const c of caps) {
    const existing = await prisma.discountLimit.findFirst({
      where: { role: c.role, storeId: null },
    });
    if (existing) {
      await prisma.discountLimit.update({ where: { id: existing.id }, data: c });
    } else {
      await prisma.discountLimit.create({ data: { ...c, storeId: null } });
    }
    n++;
  }
  console.log(`  discount caps: ${n}`);
}

async function seedDiamondRates() {
  const rates = [
    { spec: '20cent', ratePerCarat: 18000 },
    { spec: '50cent', ratePerCarat: 40000 },
    { spec: '1ct', ratePerCarat: 55000 },
    { spec: '2ct', ratePerCarat: 90000 },
    { spec: '3ct', ratePerCarat: 130000 },
  ];
  const effectiveFrom = new Date('2026-07-01T00:00:00.000Z');
  let n = 0;
  for (const r of rates) {
    const existing = await prisma.diamondRate.findFirst({
      where: { spec: r.spec, storeId: null },
    });
    if (existing) {
      await prisma.diamondRate.update({
        where: { id: existing.id },
        data: { ratePerCarat: r.ratePerCarat, effectiveFrom },
      });
    } else {
      await prisma.diamondRate.create({ data: { ...r, storeId: null, effectiveFrom } });
    }
    n++;
  }
  console.log(`  diamond rates: ${n}`);
}

async function seedShifts(storeId) {
  if (!storeId) return;
  const shifts = [
    { name: 'Morning', startTime: '10:00', endTime: '19:00', bufferMins: 15, isNightBatch: false },
    { name: 'Night', startTime: '14:00', endTime: '22:00', bufferMins: 15, isNightBatch: true },
  ];
  let n = 0;
  for (const s of shifts) {
    const existing = await prisma.shift.findFirst({ where: { storeId, name: s.name } });
    if (existing) {
      await prisma.shift.update({ where: { id: existing.id }, data: s });
    } else {
      await prisma.shift.create({ data: { ...s, storeId } });
    }
    n++;
  }
  // Weekly off (Tuesday = 2) + one demo holiday.
  await prisma.store.update({ where: { id: storeId }, data: { weekOffDay: 2 } });
  const holidayDate = new Date('2026-08-15T00:00:00.000Z');
  const hol = await prisma.storeHoliday.findFirst({ where: { storeId, date: holidayDate } });
  if (!hol) {
    await prisma.storeHoliday.create({
      data: { storeId, date: holidayDate, label: 'Independence Day' },
    });
  }
  console.log(`  shifts: ${n} (+ week-off + holiday)`);
}

async function seedProductCosts() {
  // Give the first few products a cost price so M15 margin is demoable.
  const products = await prisma.product.findMany({
    where: { costPrice: null, price: { gt: 0 } },
    take: 25,
    select: { id: true, price: true },
  });
  let n = 0;
  for (const p of products) {
    const cost = Math.round(Number(p.price) * 0.68); // ~32% margin demo
    await prisma.product.update({ where: { id: p.id }, data: { costPrice: cost } });
    n++;
  }
  console.log(`  product costs: ${n}`);
}

async function seedReferral(storeId) {
  const code = 'RATAN-DEMO';
  const existing = await prisma.referralCode.findUnique({ where: { code } });
  if (!existing) {
    await prisma.referralCode.create({
      data: {
        code,
        referrerName: 'Ratanlall Demo Referrer',
        referrerPhone: '+91 90000 00000',
        storeId: storeId ?? null,
        maxUses: 10,
      },
    });
  }
  console.log('  referral demo code: RATAN-DEMO');
}

async function main() {
  console.log('Seeding config (idempotent)...');
  const storeId = await firstStoreId();
  await seedDiscountCaps();
  await seedDiamondRates();
  await seedShifts(storeId);
  await seedProductCosts();
  await seedReferral(storeId);
  console.log('Config seed done.');
}

main()
  .catch((e) => {
    console.error('config seed error:', e.message);
    process.exit(0); // never block a deploy on config seeding
  })
  .finally(() => prisma.$disconnect());
