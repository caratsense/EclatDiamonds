import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import type { AuthUser } from '../src/common/auth-user';
import type { HrmsService } from '../src/hrms/hrms.service';
import type { RazorpayService } from '../src/integrations/razorpay.service';
import type {
  LoyaltyApiAuth,
  LoyaltyApiService,
} from '../src/loyalty/website/loyalty-api.service';
import type { OmnichannelService } from '../src/omnichannel/omnichannel.service';
import type { PartiesService } from '../src/parties/parties.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { StoreScopeService } from '../src/common/store-scope.service';

/**
 * The import holding bucket deliberately remains visible to head office for
 * reconciliation. Visibility must never make it a branch where new business,
 * messaging or attendance is recorded. Conversely, an attendance-only office
 * is a legitimate location for HR even though sales-side writes reject it.
 *
 * These are regression tests for that distinction, plus the two historical
 * callbacks that must survive a branch closing: Razorpay settlement and a
 * loyalty reversal.
 */

const IDS = {
  org: 'org_operational_boundary',
  active: 'store_operational_active',
  holding: 'store_operational_holding',
  attendance: 'store_operational_attendance',
  closed: 'store_operational_closed',
  user: 'user_operational_boundary',
};

const user: AuthUser = {
  id: IDS.user,
  name: 'Boundary Head Office',
  email: 'boundary.ho@example.test',
  role: 'head_office',
  organisationId: IDS.org,
  storeIds: [IDS.active, IDS.holding, IDS.attendance, IDS.closed],
  allStores: true,
};

const websiteAuth: LoyaltyApiAuth = {
  organisationId: IDS.org,
  integrationId: 'integration_not_needed_without_webhook',
  config: {
    earnPoints: 1,
    earnPerAmount: 100,
    minRedeemPoints: 1,
  },
};

async function teardown(prisma: PrismaService) {
  await prisma.jobTask.deleteMany({ where: { organisationId: IDS.org } });
  await prisma.loyaltyWebhookDelivery.deleteMany({ where: { organisationId: IDS.org } });
  await prisma.loyaltyLedgerEntry.deleteMany({ where: { organisationId: IDS.org } });
  await prisma.loyaltyAccount.deleteMany({ where: { organisationId: IDS.org } });
  await prisma.message.deleteMany({ where: { organisationId: IDS.org } });
  await prisma.conversation.deleteMany({ where: { organisationId: IDS.org } });
  await prisma.contactPoint.deleteMany({ where: { organisationId: IDS.org } });
  await prisma.payment.deleteMany({ where: { organisationId: IDS.org } });
  await prisma.shift.deleteMany({ where: { organisationId: IDS.org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: IDS.org } });
  await prisma.party.deleteMany({ where: { organisationId: IDS.org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: IDS.org } } });
  await prisma.user.deleteMany({ where: { organisationId: IDS.org } });
  await prisma.store.deleteMany({ where: { organisationId: IDS.org } });
  await prisma.organisation.deleteMany({ where: { id: IDS.org } });
}

describe('holding, attendance and historical store boundaries (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let parties: PartiesService;
  let hrms: HrmsService;
  let loyalty: LoyaltyApiService;
  let omnichannel: OmnichannelService;
  let razorpay: RazorpayService;
  let scope: StoreScopeService;

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService: P } = await import('../src/prisma/prisma.service');
    const { PartiesService: PartyService } = await import('../src/parties/parties.service');
    const { HrmsService: H } = await import('../src/hrms/hrms.service');
    const { LoyaltyApiService: L } = await import(
      '../src/loyalty/website/loyalty-api.service'
    );
    const { OmnichannelService: O } = await import('../src/omnichannel/omnichannel.service');
    const { RazorpayService: R } = await import('../src/integrations/razorpay.service');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(P);
    parties = app.get(PartyService);
    hrms = app.get(H);
    loyalty = app.get(L);
    omnichannel = app.get(O);
    razorpay = app.get(R);
    const { StoreScopeService: S } = await import('../src/common/store-scope.service');
    scope = app.get(S);

    await teardown(prisma);
    await prisma.organisation.create({
      data: {
        id: IDS.org,
        name: 'Operational Boundary Test',
        slug: 'operational-boundary-test',
        industryPackCode: 'retail',
        country: 'IN',
      },
    });
    await prisma.store.createMany({
      data: [
        {
          id: IDS.active,
          organisationId: IDS.org,
          name: 'Active Branch',
          city: 'Mumbai',
          status: 'active',
          isActive: true,
        },
        {
          id: IDS.holding,
          organisationId: IDS.org,
          name: 'Unassigned import holding',
          city: '',
          status: 'pending',
          isActive: false,
          isHolding: true,
        },
        {
          id: IDS.attendance,
          organisationId: IDS.org,
          name: 'Head Office',
          city: 'Mumbai',
          status: 'active',
          isActive: true,
          attendanceOnly: true,
        },
        {
          id: IDS.closed,
          organisationId: IDS.org,
          name: 'Closed physical branch',
          city: 'Mumbai',
          status: 'closed',
          isActive: false,
        },
      ],
    });
    await prisma.user.create({
      data: {
        id: IDS.user,
        organisationId: IDS.org,
        email: user.email,
        name: user.name,
        role: user.role,
        passwordHash: 'not-used',
        isActive: true,
        approvalStatus: 'approved',
      },
    });
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  it('blocks a manual customer and bare-number message at the import holding bucket', async () => {
    await expect(
      parties.create(user, {
        storeId: IDS.holding,
        name: 'Must Not Become A Customer',
        phone: '9876501001',
      }),
    ).rejects.toThrow(/holding area|physical store/i);

    const party = await prisma.party.create({
      data: {
        organisationId: IDS.org,
        storeId: IDS.holding,
        name: 'Imported Pending Customer',
        phone: '9876501002',
        contactPoints: {
          create: {
            organisationId: IDS.org,
            kind: 'whatsapp',
            value: '9876501002',
            valueNormalized: '919876501002',
            isPrimary: true,
          },
        },
      },
    });
    expect(party.storeId).toBe(IDS.holding);

    await expect(
      omnichannel.queueToContact(user, {
        to: '9876501002',
        purpose: 'service',
        body: 'This must not be routed from a holding bucket.',
      }),
    ).rejects.toThrow(/holding area|physical store/i);
  });

  it('allows HR configuration at attendance-only Head Office but not at holding', async () => {
    const shift = await hrms.createShift(user, {
      storeId: IDS.attendance,
      name: 'Head Office Day',
      startTime: '09:30',
      endTime: '18:30',
    });
    expect(shift.storeId).toBe(IDS.attendance);

    await expect(
      hrms.createShift(user, {
        storeId: IDS.holding,
        name: 'Impossible Holding Shift',
        startTime: '09:30',
        endTime: '18:30',
      }),
    ).rejects.toThrow(/store not found/i);
  });

  it('rejects inherited holding-store loyalty enrolment', async () => {
    await prisma.party.create({
      data: {
        organisationId: IDS.org,
        storeId: IDS.holding,
        name: 'Holding Loyalty Prospect',
        phone: '9876501003',
      },
    });

    await expect(
      loyalty.enroll(websiteAuth, { phone: '9876501003' }),
    ).rejects.toThrow(/active physical branch/i);
    expect(
      await prisma.loyaltyAccount.count({
        where: { organisationId: IDS.org, phone: '9876501003' },
      }),
    ).toBe(0);
  });

  it('replays an earn and reverses it after its physical branch closes', async () => {
    await prisma.store.update({
      where: { id: IDS.active },
      data: { status: 'active', isActive: true },
    });
    await loyalty.enroll(websiteAuth, {
      phone: '9876501004',
      name: 'Closure Case',
      storeId: IDS.active,
    });
    const earned = await loyalty.earn(websiteAuth, {
      phone: '9876501004',
      amount: 1_000,
      idempotencyKey: 'boundary-earn-0001',
      storeId: IDS.active,
    });
    expect(earned.points).toBe(10);

    await prisma.store.update({
      where: { id: IDS.active },
      data: { status: 'closed', isActive: false },
    });

    const replay = await loyalty.earn(websiteAuth, {
      phone: '9876501004',
      amount: 99_900,
      idempotencyKey: 'boundary-earn-0001',
      storeId: IDS.active,
    });
    expect(replay.idempotent).toBe(true);
    expect(replay.entryId).toBe(earned.entryId);

    const reversed = await loyalty.reverse(websiteAuth, {
      idempotencyKey: 'boundary-reverse-0001',
      originalIdempotencyKey: 'boundary-earn-0001',
    });
    expect(reversed.points).toBe(-10);
    expect(reversed.balance).toBe(0);
  });

  it('separates a new customer transaction from work against what a branch already holds', async () => {
    // Its own open branch: an earlier test in this file closes IDS.active.
    const open = await prisma.store.create({
      data: {
        id: 'store_operational_open',
        organisationId: IDS.org,
        name: 'Open Branch',
        city: 'Mumbai',
        status: 'active',
        isActive: true,
      },
      select: { id: true },
    });
    // A branch Gati has just revealed is pending review and already selling.
    const pending = await prisma.store.create({
      data: {
        id: 'store_operational_pending',
        organisationId: IDS.org,
        name: 'Pending Branch',
        city: 'Mumbai',
        status: 'pending',
        isActive: false,
      },
      select: { id: true },
    });

    // 'trading' — a new sale, quote, lead or walk-in.
    await expect(scope.assertTradingStore(open.id)).resolves.toBeUndefined();
    await expect(scope.assertTradingStore(pending.id)).resolves.toBeUndefined();
    await expect(scope.assertTradingStore(IDS.closed)).rejects.toThrow(/closed/i);
    await expect(scope.assertTradingStore(IDS.holding)).rejects.toThrow(/holding/i);
    await expect(scope.assertTradingStore(IDS.attendance)).rejects.toThrow(/attendance/i);

    // 'physical' — stock leaving, or a return of goods sold there. Emptying a
    // closed branch or the holding bucket is the only way either stops holding
    // stock, so both are allowed; an office still is not.
    await expect(scope.assertTradingStore(IDS.closed, 'physical')).resolves.toBeUndefined();
    await expect(scope.assertTradingStore(IDS.holding, 'physical')).resolves.toBeUndefined();
    await expect(scope.assertTradingStore(pending.id, 'physical')).resolves.toBeUndefined();
    await expect(scope.assertTradingStore(IDS.attendance, 'physical')).rejects.toThrow(/attendance/i);

    await prisma.store.delete({ where: { id: pending.id } });
    await prisma.store.delete({ where: { id: open.id } });
  });

  it('rejects holding-store payment callbacks but records late settlement for a closed branch', async () => {
    const event = (paymentId: string, storeId: string) => ({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentId,
            amount: 125_000,
            created_at: 1_795_027_200,
            notes: { storeId },
          },
        },
      },
    });

    await expect(razorpay.handleWebhook(event('pay_holding_boundary', IDS.holding))).resolves.toEqual({
      handled: false,
      reason: 'unknown or non-trading store',
    });
    expect(
      await prisma.payment.count({
        where: { organisationId: IDS.org, reference: 'pay_holding_boundary' },
      }),
    ).toBe(0);

    await expect(razorpay.handleWebhook(event('pay_closed_boundary', IDS.closed))).resolves.toEqual({
      handled: true,
    });
    const payment = await prisma.payment.findFirstOrThrow({
      where: { organisationId: IDS.org, reference: 'pay_closed_boundary' },
    });
    expect(payment.storeId).toBe(IDS.closed);
    expect(Number(payment.amount)).toBe(1_250);
  });
});
