import type { PrismaService } from '../prisma/prisma.service';

/**
 * Idempotent CONFIG bootstrap — runs on app startup (see main.ts), so the lookup
 * data the new modules need is guaranteed present even when the platform skips
 * deploy-time seed hooks. Seeds: discount caps (M15), diamond rates (M14),
 * a demo shift set + week-off (M6), product cost prices (M15 margin) and a demo
 * referral code (M17). Never deletes; skips entirely once already seeded.
 */
export async function seedConfig(prisma: PrismaService): Promise<void> {
  // Fast path: if diamond rates already exist we've seeded before — no-op.
  if ((await prisma.diamondRate.count()) > 0) return;

  const store =
    (await prisma.store.findFirst({ where: { isAggregate: false }, select: { id: true } })) ??
    (await prisma.store.findFirst({ select: { id: true } }));
  const storeId = store?.id ?? null;

  // ── M15 discount caps (split diamond/making %) ──────────────────────────────
  const caps = [
    { role: 'salesperson' as const, maxDiamondPercent: 2, maxMakingPercent: 5, maxPercent: 2 },
    { role: 'store_manager' as const, maxDiamondPercent: 5, maxMakingPercent: 10, maxPercent: 10 },
    { role: 'area_manager' as const, maxDiamondPercent: 20, maxMakingPercent: 20, maxPercent: 20 },
    { role: 'head_office' as const, maxDiamondPercent: 100, maxMakingPercent: 100, maxPercent: 100 },
  ];
  for (const c of caps) {
    const existing = await prisma.discountLimit.findFirst({
      where: { role: c.role, storeId: null },
    });
    if (existing) {
      await prisma.discountLimit.update({ where: { id: existing.id }, data: c });
    } else {
      await prisma.discountLimit.create({ data: { ...c, storeId: null } });
    }
  }

  // ── M14 diamond rates (₹/carat by spec) ─────────────────────────────────────
  const effectiveFrom = new Date('2026-07-01T00:00:00.000Z');
  const rates = [
    { spec: '20cent', ratePerCarat: 18000 },
    { spec: '50cent', ratePerCarat: 40000 },
    { spec: '1ct', ratePerCarat: 55000 },
    { spec: '2ct', ratePerCarat: 90000 },
    { spec: '3ct', ratePerCarat: 130000 },
  ];
  for (const r of rates) {
    await prisma.diamondRate.create({ data: { ...r, storeId: null, effectiveFrom } });
  }

  // ── M6 shifts + week-off + a holiday ────────────────────────────────────────
  if (storeId) {
    const shifts = [
      { name: 'Morning', startTime: '10:00', endTime: '19:00', bufferMins: 15, isNightBatch: false },
      { name: 'Night', startTime: '14:00', endTime: '22:00', bufferMins: 15, isNightBatch: true },
    ];
    for (const s of shifts) {
      const existing = await prisma.shift.findFirst({ where: { storeId, name: s.name } });
      if (!existing) await prisma.shift.create({ data: { ...s, storeId } });
    }
    await prisma.store.update({ where: { id: storeId }, data: { weekOffDay: 2 } });
    const holidayDate = new Date('2026-08-15T00:00:00.000Z');
    const hol = await prisma.storeHoliday.findFirst({ where: { storeId, date: holidayDate } });
    if (!hol) {
      await prisma.storeHoliday.create({
        data: { storeId, date: holidayDate, label: 'Independence Day' },
      });
    }
  }

  // ── M15 product cost prices (so margin is demoable) ─────────────────────────
  const products = await prisma.product.findMany({
    where: { costPrice: null, price: { gt: 0 } },
    take: 40,
    select: { id: true, price: true },
  });
  for (const p of products) {
    await prisma.product.update({
      where: { id: p.id },
      data: { costPrice: Math.round(Number(p.price) * 0.68) },
    });
  }

  // ── M17 demo referral code ──────────────────────────────────────────────────
  const code = 'ECLAT-DEMO';
  if (!(await prisma.referralCode.findUnique({ where: { code } }))) {
    await prisma.referralCode.create({
      data: {
        code,
        referrerName: 'Éclat Demo Referrer',
        referrerPhone: '+91 90000 00000',
        storeId: storeId ?? null,
        maxUses: 10,
      },
    });
  }
}
