/**
 * The modules the main seed leaves empty.
 *
 * `seed.mjs` fills the parts of the product that were built first — leads,
 * quotes, sales, stock, attendance — and a screen with nothing on it looks
 * broken rather than new, so the rest of the modules were opening blank: the
 * gold scheme, loyalty, stock transfers, payroll, marketing campaigns, sales
 * targets, special requests. This fills those, so every module has something to
 * show and every list, filter and total has a shape to render.
 *
 * Idempotent, like the main seed: stable ids and upserts throughout, so running
 * it twice changes nothing.
 *
 * NOT seeded, deliberately:
 *   - `AdSpendDaily` — invented figures would read as real money spent on real
 *     campaigns. It fills from the Meta integration or not at all.
 *   - Delivery logs, webhook events, OTPs, sync state — these are records of
 *     things happening, and writing them without the thing having happened
 *     makes the audit trail lie.
 */
const ORG = 'org_eclat';

/** Midnight UTC, n days before today — so a reseed keeps the same shape. */
const daysAgo = (n) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
};
const monthKey = (back = 0) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - back);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

export async function seedModules(prisma) {
  const counts = {};
  const note = (k, n) => {
    counts[k] = n;
  };

  const stores = await prisma.store.findMany({
    where: { organisationId: ORG, isAggregate: false },
    select: { id: true, name: true },
    orderBy: { id: 'asc' },
  });
  const byId = (id) => stores.find((s) => s.id === id) ?? stores[0];
  const surat = byId('surat-main');
  const bandra = byId('mumbai-bandra');
  const ahmedabad = byId('ahmedabad-cg');
  if (!surat || !bandra) return counts;

  /* ------------------------------------------- Module 17: gold savings scheme */
  const plans = await prisma.schemePlan.findMany({ where: { organisationId: ORG } });
  if (plans.length) {
    const members = [
      { id: 'scm-1', ref: 'GS-0001', store: surat, party: 'pty-meera', name: 'Meera Joshi', phone: '9820011111', amount: 5000, tenure: 11, paid: 7, status: 'active' },
      { id: 'scm-2', ref: 'GS-0002', store: bandra, party: 'pty-neha', name: 'Neha Shah', phone: '9820022222', amount: 10000, tenure: 11, paid: 11, status: 'matured' },
      { id: 'scm-3', ref: 'GS-0003', store: surat, party: null, name: 'Rakesh Patel', phone: '9820033333', amount: 3000, tenure: 11, paid: 2, status: 'defaulted' },
    ];
    for (const [i, m] of members.entries()) {
      const plan = plans[i % plans.length];
      const enrolledAt = daysAgo(30 * m.tenure);
      await prisma.schemeMember.upsert({
        where: { id: m.id },
        update: { status: m.status },
        create: {
          id: m.id,
          organisationId: ORG,
          ref: m.ref,
          storeId: m.store.id,
          partyId: m.party,
          planId: plan.id,
          customerName: m.name,
          phone: m.phone,
          installment: m.amount,
          tenureMonths: m.tenure,
          bonusMonths: 1,
          status: m.status,
          enrolledAt,
        },
      });
      for (let seq = 1; seq <= m.tenure; seq += 1) {
        const dueDate = daysAgo(30 * (m.tenure - seq + 1));
        const paid = seq <= m.paid;
        // A defaulted member has a gap, not a clean prefix: that is what
        // "defaulted" looks like on the screen the manager chases from.
        const missed = m.status === 'defaulted' && !paid;
        await prisma.schemeInstallment.upsert({
          where: { memberId_sequence: { memberId: m.id, sequence: seq } },
          update: {},
          create: {
            memberId: m.id,
            sequence: seq,
            dueDate,
            amount: m.amount,
            status: paid ? 'paid' : missed ? 'missed' : 'due',
            paidAt: paid ? dueDate : null,
            goldRate: paid ? 6800 + seq * 25 : null,
            goldWeightG: paid ? Number((m.amount / (6800 + seq * 25)).toFixed(3)) : null,
          },
        });
      }
    }
    note('scheme members', members.length);
  }

  /* ------------------------------------------------------ Module 17: loyalty */
  const loyalty = [
    { phone: '9820011111', name: 'Meera Joshi', party: 'pty-meera', store: surat, tier: 'Gold', earned: 4200, redeemed: 1500 },
    { phone: '9820044444', name: 'Aisha Khan', party: null, store: bandra, tier: 'Silver', earned: 900, redeemed: 0 },
    { phone: '9820055555', name: 'Sanjay Rao', party: 'pty-sanjay', store: surat, tier: null, earned: 250, redeemed: 250 },
  ];
  for (const a of loyalty) {
    const balance = a.earned - a.redeemed;
    const account = await prisma.loyaltyAccount.upsert({
      where: { organisationId_phone: { organisationId: ORG, phone: a.phone } },
      update: { pointsBalance: balance, lifetimeEarned: a.earned, lifetimeRedeemed: a.redeemed },
      create: {
        organisationId: ORG,
        phone: a.phone,
        name: a.name,
        partyId: a.party,
        storeId: a.store.id,
        tier: a.tier,
        pointsBalance: balance,
        lifetimeEarned: a.earned,
        lifetimeRedeemed: a.redeemed,
        enrolledAt: daysAgo(210),
      },
    });
    // The ledger has to arrive at the balance above, or the account and its
    // history tell two different stories.
    const entries = [
      { kind: 'earn', points: a.earned, after: a.earned, reason: 'Purchase', at: daysAgo(120) },
      ...(a.redeemed
        ? [{ kind: 'redeem', points: -a.redeemed, after: balance, reason: 'Redeemed against a bill', at: daysAgo(20) }]
        : []),
    ];
    for (const [i, e] of entries.entries()) {
      const key = `seed-${a.phone}-${i}`;
      await prisma.loyaltyLedgerEntry.upsert({
        where: { organisationId_idempotencyKey: { organisationId: ORG, idempotencyKey: key } },
        update: {},
        create: {
          organisationId: ORG,
          accountId: account.id,
          kind: e.kind,
          points: e.points,
          balanceAfter: e.after,
          reason: e.reason,
          storeId: a.store.id,
          source: 'store',
          actorType: 'system',
          idempotencyKey: key,
          createdAt: e.at,
        },
      });
    }
  }
  note('loyalty accounts', loyalty.length);

  /* ------------------------------------------ Module 9: stock transfers */
  const items = await prisma.stockItem.findMany({
    where: { organisationId: ORG },
    select: { id: true, storeId: true, sku: true, name: true },
    take: 6,
  });
  const ho = await prisma.user.findFirst({ where: { organisationId: ORG, role: 'head_office' }, select: { id: true } });
  const sm = await prisma.user.findFirst({ where: { organisationId: ORG, role: 'store_manager' }, select: { id: true } });
  if (items.length >= 2 && ho && sm) {
    const transfers = [
      { id: 'trf-1', ref: 'TR-0001', from: surat, to: bandra, status: 'received', reason: 'Bandra is short of ladies rings for the weekend', pick: items.filter((i) => i.storeId === surat.id).slice(0, 2) },
      { id: 'trf-2', ref: 'TR-0002', from: bandra, to: ahmedabad ?? surat, status: 'submitted', reason: 'Moving slow-moving stock to a store that asks for it', pick: items.filter((i) => i.storeId === bandra.id).slice(0, 1) },
    ];
    let moved = 0;
    for (const t of transfers) {
      if (!t.pick.length) continue;
      const done = t.status === 'received';
      await prisma.stockTransfer.upsert({
        where: { id: t.id },
        update: { status: t.status },
        create: {
          id: t.id,
          organisationId: ORG,
          ref: t.ref,
          status: t.status,
          fromStoreId: t.from.id,
          toStoreId: t.to.id,
          reason: t.reason,
          requestedById: sm.id,
          submittedAt: daysAgo(done ? 9 : 2),
          ...(done
            ? {
                approvedById: ho.id,
                approvedAt: daysAgo(8),
                dispatchedById: sm.id,
                dispatchedAt: daysAgo(7),
                receivedById: sm.id,
                receivedAt: daysAgo(5),
              }
            : {}),
        },
      });
      for (const it of t.pick) {
        await prisma.stockTransferItem.upsert({
          where: { id: `${t.id}-${it.id}` },
          update: {},
          create: { id: `${t.id}-${it.id}`, transferId: t.id, stockItemId: it.id, sku: it.sku, name: it.name },
        });
        if (done) {
          await prisma.stockMovement.upsert({
            where: { id: `mov-${t.id}-${it.id}` },
            update: {},
            create: {
              id: `mov-${t.id}-${it.id}`,
              organisationId: ORG,
              stockItemId: it.id,
              fromStoreId: t.from.id,
              toStoreId: t.to.id,
              status: 'received',
              note: `Transfer ${t.ref}`,
              occurredAt: daysAgo(5),
              stockTransferId: t.id,
            },
          });
          moved += 1;
        }
      }
    }
    note('stock transfers', transfers.length);
    note('stock movements', moved);
  }

  /* --------------------------------------------- Module 10: sales targets */
  const staff = await prisma.user.findMany({
    where: { organisationId: ORG, role: { in: ['salesperson', 'store_manager'] } },
    select: { id: true },
    take: 4,
  });
  // Everyone on the payroll, not a sample: the generator skips a person with no
  // pay recorded, so a partial list produces a payslip run that is mostly
  // "skipped" and a screen that looks broken.
  const onPayroll = await prisma.user.findMany({
    where: { organisationId: ORG, isActive: true },
    select: { id: true, role: true },
  });
  let targets = 0;
  for (const period of [monthKey(1), monthKey(0)]) {
    for (const store of [surat, bandra]) {
      await prisma.salesTarget.upsert({
        where: { id: `tgt-${store.id}-${period}` },
        update: {},
        create: { id: `tgt-${store.id}-${period}`, storeId: store.id, period, amount: 4500000, createdById: ho?.id ?? null },
      });
      targets += 1;
    }
    for (const s of staff) {
      await prisma.salesTarget.upsert({
        where: { storeId_staffId_period: { storeId: surat.id, staffId: s.id, period } },
        update: {},
        create: { storeId: surat.id, staffId: s.id, period, amount: 900000, createdById: ho?.id ?? null },
      });

      targets += 1;
    }
  }
  note('sales targets', targets);

  /* ------------------------------------------------- Module 6: pay and week-off */
  let comps = 0;
  for (const s of onPayroll) {
    await prisma.staffCompensation.upsert({
      where: { id: `comp-${s.id}` },
      update: {},
      create: {
        id: `comp-${s.id}`,
        organisationId: ORG,
        userId: s.id,
        amount: { head_office: 90000, area_manager: 70000, store_manager: 55000, marketing: 45000, storeperson: 26000 }[s.role] ?? 32000,
        basis: 'monthly',
      },
    });
    await prisma.staffWeekOff.upsert({
      where: { id: `woff-${s.id}` },
      update: {},
      create: { id: `woff-${s.id}`, organisationId: ORG, userId: s.id, dayOfWeek: 2 },
    });
    comps += 1;
  }
  note('staff pay + week-off', comps);

  /* ------------------------------------------- Module 13: special requests */
  if (sm && ho) {
    const requests = [
      { id: 'sr-1', ref: 'SR-0001', kind: 'price_override', title: 'Match a competitor quote on a 2ct solitaire', status: 'pending', priority: 'high' },
      { id: 'sr-2', ref: 'SR-0002', kind: 'expense', title: 'Replace the counter display light at Bandra', status: 'approved', priority: 'low' },
    ];
    for (const r of requests) {
      await prisma.specialRequest.upsert({
        where: { id: r.id },
        update: { status: r.status },
        create: {
          id: r.id,
          organisationId: ORG,
          ref: r.ref,
          storeId: bandra.id,
          kind: r.kind,
          title: r.title,
          priority: r.priority,
          status: r.status,
          requestedById: sm.id,
          requestedRole: 'store_manager',
          requiredRole: 'head_office',
        },
      });
      await prisma.specialRequestMessage.upsert({
        where: { id: `${r.id}-m1` },
        update: {},
        create: { id: `${r.id}-m1`, requestId: r.id, body: 'Raised from the store floor; customer is waiting.' },
      });
    }
    note('special requests', requests.length);
  }

  /* --------------------------------------------- Module 16: campaigns */
  const segment = await prisma.audienceSegment.upsert({
    where: { id: 'seg-diwali' },
    update: {},
    create: {
      id: 'seg-diwali',
      organisationId: ORG,
      name: 'Bought in the last year, no visit in 90 days',
      definition: { boughtWithinDays: 365, notSeenForDays: 90 },
    },
  });
  await prisma.messagingCampaign.upsert({
    where: { id: 'cmp-diwali' },
    update: {},
    create: {
      id: 'cmp-diwali',
      organisationId: ORG,
      name: 'Diwali preview evening',
      status: 'completed',
      segmentId: segment.id,
    },
  });
  const contacts = ['9820011111', '9820022222', '9820044444', '9820055555'];
  for (const [i, c] of contacts.entries()) {
    await prisma.campaignRecipient.upsert({
      where: { id: `cmp-diwali-${i}` },
      update: {},
      create: { id: `cmp-diwali-${i}`, organisationId: ORG, campaignId: 'cmp-diwali', contactValue: c },
    });
  }
  note('campaign recipients', contacts.length);

  /* ----------------------------------------------------------- odds and ends */
  const code = await prisma.referralCode.findFirst({ where: { organisationId: ORG }, select: { id: true } });
  if (code) {
    await prisma.referral.upsert({
      where: { id: 'ref-1' },
      update: {},
      create: { id: 'ref-1', codeId: code.id, refereeName: 'Anita Desai', billAmount: 185000 },
    });
    note('referrals', 1);
  }

  const orders = await prisma.manufacturingOrder.findMany({ where: { organisationId: ORG }, select: { id: true }, take: 3 });
  for (const [i, o] of orders.entries()) {
    await prisma.manufacturingOrderItem.upsert({
      where: { id: `mfgi-${o.id}` },
      update: {},
      create: { id: `mfgi-${o.id}`, organisationId: ORG, orderId: o.id, status: ['casting', 'polishing', 'ready'][i % 3] },
    });
  }
  if (orders.length) note('manufacturing order items', orders.length);

  return counts;
}
