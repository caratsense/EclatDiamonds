import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { SequenceService } from '../common/sequence.service';
import { ROLE_RANK } from '../common/role.util';
import { AuditService } from '../common/audit.service';
import {
  CreateReferralCodeDto,
  CreateReferralDto,
  CreateSchemePlanDto,
  EnrollMemberDto,
  ReferralPayoutDto,
  UpdateSchemePlanDto,
} from './dto/loyalty.dto';

function num(v: Prisma.Decimal | number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

// Module 17 "Earn with Éclat" defaults (client rules, CLIENT-CALL-2026-07).
/** Diamond discount the referee (Y) receives, as a percent of the bill. */
const DIAMOND_DISCOUNT_PCT = 5;
/** Commission the referrer (X) earns, as a percent of the referee's total bill. */
const COMMISSION_PCT = 5;

/** billAmount * pct/100, rounded to whole paise (2dp) — exact Decimal math. */
function pctOf(bill: Prisma.Decimal, pct: number): Prisma.Decimal {
  return bill.mul(new Prisma.Decimal(pct)).div(100).toDecimalPlaces(2);
}

/** Parse a yyyy-mm-dd string into a UTC-midnight Date for a `@db.Date` column. */
function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

@Injectable()
export class LoyaltyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
    private readonly sequence: SequenceService,
  ) {}

  /** Shape a SchemePlan for the API. */
  private planView(p: any) {
    return {
      id: p.id,
      name: p.name,
      tenureMonths: p.tenureMonths,
      bonusMonths: p.bonusMonths,
      bonusLabel: p.bonusLabel ?? '',
      defaultInstallment:
        p.defaultInstallment != null ? Number(p.defaultInstallment) : null,
      isActive: p.isActive,
    };
  }

  /**
   * GET /loyalty/plans — the scheme plans this business offers (not store-scoped).
   * Enrollment only ever offers ACTIVE plans; `includeInactive` is for the Head
   * Office management screen, which must also see retired ones.
   */
  async plans(user: AuthUser, includeInactive = false) {
    const organisationId = user.organisationId;
    const filter = includeInactive ? { organisationId } : { organisationId, isActive: true };
    let plans = await this.prisma.schemePlan.findMany({
      where: filter,
      orderBy: { createdAt: 'asc' },
    });
    if (plans.length === 0) {
      await this.prisma.schemePlan.createMany({
        data: [
          { name: '10+1 Gold Savings Scheme', tenureMonths: 10, bonusMonths: 1, bonusLabel: '1 Month Company Bonus', defaultInstallment: new Prisma.Decimal(5000), isActive: true, organisationId },
          { name: '10+2 Premium Gold Scheme', tenureMonths: 10, bonusMonths: 2, bonusLabel: '2 Months Company Bonus', defaultInstallment: new Prisma.Decimal(10000), isActive: true, organisationId },
        ],
      });
      plans = await this.prisma.schemePlan.findMany({
        where: filter,
        orderBy: { createdAt: 'asc' },
      });
    }
    return plans.map((p) => this.planView(p));
  }

  /**
   * POST /loyalty/plans — Head Office defines a scheme (e.g. "₹5,000 × 11 months,
   * 12th free"). The UI offers common templates, but they are only pre-filled
   * values: everything here is client-authored, nothing is seeded.
   */
  async createPlan(user: AuthUser, dto: CreateSchemePlanDto) {
    const plan = await this.prisma.schemePlan.create({
      data: {
        name: dto.name.trim(),
        tenureMonths: dto.tenureMonths,
        bonusMonths: dto.bonusMonths ?? 0,
        bonusLabel: dto.bonusLabel?.trim() || null,
        defaultInstallment: dto.defaultInstallment ?? null,
        isActive: dto.isActive ?? true,
        organisationId: user.organisationId,
      },
    });
    await this.audit.record(user, {
      action: 'scheme_plan.create',
      entityType: 'SchemePlan',
      entityId: plan.id,
      storeId: null,
      summary: `Created scheme plan "${plan.name}" (${plan.tenureMonths}+${plan.bonusMonths})`,
      metadata: { tenureMonths: plan.tenureMonths, bonusMonths: plan.bonusMonths },
    });
    return this.planView(plan);
  }

  /** PATCH /loyalty/plans/:id — rename / retune / activate / deactivate a plan. */
  async updatePlan(user: AuthUser, id: string, dto: UpdateSchemePlanDto) {
    const existing = await this.prisma.schemePlan.findFirst({
      where: { id, ...this.scope.orgFilter(user) },
    });
    if (!existing) throw new NotFoundException('Scheme plan not found');

    const plan = await this.prisma.schemePlan.update({
      where: { id },
      data: {
        ...(dto.name != null ? { name: dto.name.trim() } : {}),
        ...(dto.tenureMonths != null ? { tenureMonths: dto.tenureMonths } : {}),
        ...(dto.bonusMonths != null ? { bonusMonths: dto.bonusMonths } : {}),
        ...(dto.bonusLabel !== undefined
          ? { bonusLabel: dto.bonusLabel?.trim() || null }
          : {}),
        ...(dto.defaultInstallment !== undefined
          ? { defaultInstallment: dto.defaultInstallment }
          : {}),
        ...(dto.isActive != null ? { isActive: dto.isActive } : {}),
      },
    });
    await this.audit.record(user, {
      action: 'scheme_plan.update',
      entityType: 'SchemePlan',
      entityId: id,
      storeId: null,
      summary: `Updated scheme plan "${plan.name}"`,
      metadata: { from: existing.name, to: plan.name, isActive: plan.isActive },
    });
    return this.planView(plan);
  }

  /**
   * DELETE /loyalty/plans/:id — only while nothing is enrolled on it. Once members
   * exist the plan is part of their history, so we refuse and point at deactivate,
   * which hides it from new enrollments without rewriting the past.
   */
  async deletePlan(user: AuthUser, id: string) {
    const existing = await this.prisma.schemePlan.findFirst({
      where: { id, ...this.scope.orgFilter(user) },
    });
    if (!existing) throw new NotFoundException('Scheme plan not found');

    const enrolled = await this.prisma.schemeMember.count({ where: { planId: id } });
    if (enrolled > 0) {
      throw new ConflictException(
        `${enrolled} member(s) are enrolled on this plan. Deactivate it instead so their history is kept.`,
      );
    }

    await this.prisma.schemePlan.delete({ where: { id } });
    await this.audit.record(user, {
      action: 'scheme_plan.delete',
      entityType: 'SchemePlan',
      entityId: id,
      storeId: null,
      summary: `Deleted scheme plan "${existing.name}"`,
      metadata: { name: existing.name },
    });
    return { ok: true };
  }

  /** GET /loyalty/members — enrolled accounts with paid/missed installments + maturity. */
  async members(user: AuthUser, headerStore?: string) {
    const rows = await this.prisma.schemeMember.findMany({
      where: this.scope.storeFilter(user, headerStore),
      include: { installments: true },
      orderBy: { enrolledAt: 'desc' },
    });
    // An installment is only "missed" once its due DAY has fully passed. dueDate
    // is a @db.Date (UTC midnight), so compare against the start of today in UTC
    // — not `Date.now()`, which would flag an installment due today (e.g. month
    // one of a brand-new enrollment) as already overdue.
    const startOfToday = (() => {
      const d = new Date();
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    })();
    return rows.map((m) => {
      const paidMonths = m.installments.filter((i) => i.status === 'paid').length;
      const missedMonths = m.installments.filter(
        (i) => i.status === 'missed' || (i.status === 'due' && i.dueDate.getTime() < startOfToday),
      ).length;
      return {
        id: m.id,
        ref: m.ref,
        storeId: m.storeId,
        customer: m.customerName,
        phone: m.phone ?? '',
        planId: m.planId,
        installment: num(m.installment),
        tenureMonths: m.tenureMonths,
        bonusMonths: m.bonusMonths,
        paidMonths,
        missedMonths,
        enrolledAt: m.enrolledAt.toISOString(),
        status: m.status,
      };
    });
  }

  /** POST /loyalty/members — enroll a member and generate the installment schedule. */
  async enroll(user: AuthUser, dto: EnrollMemberDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);
    const plan = await this.prisma.schemePlan.findFirst({
      where: { id: dto.planId, ...this.scope.orgFilter(user) },
    });
    if (!plan) throw new NotFoundException('Scheme plan not found');

    const year = new Date().getFullYear();
    // Sequence-backed per year: a scheme ref is printed on the customer's
    // passbook, so two members must never be handed the same one.
    const seq = await this.sequence.next(`GSS:${year}`);
    const enrolledAt = new Date();

    const member = await this.prisma.schemeMember.create({
      data: {
        organisationId: user.organisationId,
        ref: `GSS-${year}-${3000 + seq}`,
        storeId: dto.storeId,
        customerName: dto.customerName,
        phone: dto.phone,
        planId: plan.id,
        installment: new Prisma.Decimal(dto.installment),
        tenureMonths: plan.tenureMonths,
        bonusMonths: plan.bonusMonths,
        status: 'active',
        enrolledAt,
        installments: {
          create: Array.from({ length: plan.tenureMonths }, (_, i) => ({
            sequence: i + 1,
            // Build in UTC to match the @db.Date column. A local-time Date here
            // lands a day early in +ve-offset zones (e.g. IST), which shifted
            // month one before today and made it read back as an instant miss.
            dueDate: new Date(Date.UTC(enrolledAt.getUTCFullYear(), enrolledAt.getUTCMonth() + i, enrolledAt.getUTCDate())),
            amount: new Prisma.Decimal(dto.installment),
            status: 'due' as const,
          })),
        },
      },
      include: { installments: true },
    });

    return {
      id: member.id,
      ref: member.ref,
      storeId: member.storeId,
      customer: member.customerName,
      phone: member.phone ?? '',
      planId: member.planId,
      installment: num(member.installment),
      tenureMonths: member.tenureMonths,
      bonusMonths: member.bonusMonths,
      paidMonths: 0,
      missedMonths: 0,
      enrolledAt: member.enrolledAt.toISOString(),
      status: member.status,
    };
  }

  // ==========================================================================
  // MODULE 17 — "Earn with Éclat" referral / commission program
  // ==========================================================================

  /**
   * Scope fragment for referral codes/referrals: the user's scoped stores plus
   * null-store (company-wide) rows, which everyone in scope may see. HO = no filter.
   * Mirrors the ticketing pattern for nullable-store entities.
   */
  private scopedWhere(user: AuthUser, headerStore?: string) {
    // Org-bind the WHOLE fragment: storeFilter never returns {} (head_office is
    // already org-bounded via user.storeIds), so a bare `{ storeId: null }` OR
    // branch would match EVERY tenant's company-wide rows. The organisationId
    // predicate fences the null-store branch to the caller's organisation.
    return {
      organisationId: user.organisationId,
      OR: [this.scope.storeFilter(user, headerStore), { storeId: null }],
    };
  }

  /** A store-bound code is gated by scope; a company-wide (null-store) code is open. */
  private assertCodeAccess(user: AuthUser, storeId: string | null): void {
    if (storeId) this.scope.assertStoreAllowed(user, storeId);
  }

  /** Readable uppercase slug from the referrer's name, e.g. "Neha Sharma" -> "NEHASHARMA". */
  private codeSlug(name: string): string {
    const base = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    return base || 'REF';
  }

  /**
   * Generate a unique, human-readable code: name-slug + a short crypto suffix.
   * Retries on the (extremely unlikely) @unique collision. No Math.random/Date.now.
   */
  private async generateCode(name: string, organisationId: string): Promise<string> {
    const slug = this.codeSlug(name);
    for (let attempt = 0; attempt < 8; attempt++) {
      const suffix = randomBytes(3).toString('hex').toUpperCase(); // 6 hex chars
      const code = `${slug}-${suffix}`;
      // A code only needs to be unique within its organisation.
      const clash = await this.prisma.referralCode.findFirst({ where: { code, organisationId } });
      if (!clash) return code;
    }
    throw new BadRequestException('Could not generate a unique referral code, please retry');
  }

  private codeView(c: {
    id: string;
    code: string;
    referrerName: string;
    referrerPhone: string | null;
    storeId: string | null;
    maxUses: number | null;
    uses: number;
    commissionBalance: Prisma.Decimal;
    createdAt: Date;
  }) {
    return {
      id: c.id,
      code: c.code,
      referrerName: c.referrerName,
      referrerPhone: c.referrerPhone ?? '',
      storeId: c.storeId,
      maxUses: c.maxUses,
      uses: c.uses,
      remainingUses: c.maxUses == null ? null : Math.max(0, c.maxUses - c.uses),
      commissionBalance: num(c.commissionBalance),
      createdAt: c.createdAt.toISOString(),
    };
  }

  /** POST /loyalty/referral-codes — mint a unique coupon code for a referrer. */
  async createReferralCode(user: AuthUser, dto: CreateReferralCodeDto) {
    if (dto.storeId) {
      this.scope.assertStoreAllowed(user, dto.storeId);
    } else if (user.role !== 'head_office') {
      // A null-store code is company-wide — only head office may mint those.
      throw new ForbiddenException(
        'Only head office may create company-wide referral codes',
      );
    }
    const code = await this.generateCode(dto.referrerName, user.organisationId);
    const row = await this.prisma.referralCode.create({
      data: {
        organisationId: user.organisationId,
        code,
        referrerName: dto.referrerName,
        referrerPhone: dto.referrerPhone,
        storeId: dto.storeId,
        maxUses: dto.maxUses,
      },
    });
    return this.codeView(row);
  }

  /** GET /loyalty/referral-codes — store-scoped list with uses / cap / balance. */
  async referralCodes(user: AuthUser, headerStore?: string) {
    const rows = await this.prisma.referralCode.findMany({
      where: this.scopedWhere(user, headerStore),
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.codeView(r));
  }

  /**
   * POST /loyalty/referrals — apply a code on a referee's purchase.
   * Y gets DIAMOND_DISCOUNT_PCT off diamond; X earns COMMISSION_PCT of the total
   * bill into commissionBalance. Enforces the usage cap and updates atomically.
   */
  async createReferral(user: AuthUser, dto: CreateReferralDto) {
    if (dto.storeId) this.scope.assertStoreAllowed(user, dto.storeId);

    // SECURITY: pct overrides are area_manager+ only. For lower roles the dto
    // fields are hard-ignored (inert) and the config defaults always apply —
    // a salesperson can still apply a code, but never change the economics.
    const canOverridePct = ROLE_RANK[user.role] >= ROLE_RANK.store_manager;
    const diamondDiscountPct = canOverridePct
      ? dto.diamondDiscountPct ?? DIAMOND_DISCOUNT_PCT
      : DIAMOND_DISCOUNT_PCT;
    const commissionPct = canOverridePct
      ? dto.commissionPct ?? COMMISSION_PCT
      : COMMISSION_PCT;
    const bill = new Prisma.Decimal(dto.billAmount);
    const diamondDiscountAmount = pctOf(bill, diamondDiscountPct);
    const commissionAmount = pctOf(bill, commissionPct);

    return this.prisma.$transaction(async (tx) => {
      // Referral codes are unique PER ORGANISATION — resolve within the caller's org.
      const code = await tx.referralCode.findFirst({
        where: { code: dto.code, organisationId: user.organisationId },
      });
      if (!code) throw new NotFoundException('referral code not found');
      this.assertCodeAccess(user, code.storeId);

      if (code.maxUses != null && code.uses >= code.maxUses) {
        throw new BadRequestException('code usage limit reached');
      }

      const referral = await tx.referral.create({
        data: {
          codeId: code.id,
          refereeName: dto.refereeName,
          refereePhone: dto.refereePhone,
          storeId: dto.storeId ?? code.storeId,
          billAmount: bill,
          diamondDiscountPct: new Prisma.Decimal(diamondDiscountPct),
          diamondDiscountAmount,
          commissionPct: new Prisma.Decimal(commissionPct),
          commissionAmount,
          invoiceNo: dto.invoiceNo,
          billDate: dto.billDate ? parseYmd(dto.billDate) : undefined,
        },
      });

      const updated = await tx.referralCode.update({
        where: { id: code.id },
        data: {
          uses: { increment: 1 },
          commissionBalance: { increment: commissionAmount },
        },
      });

      return {
        id: referral.id,
        codeId: referral.codeId,
        code: code.code,
        refereeName: referral.refereeName,
        refereePhone: referral.refereePhone ?? '',
        storeId: referral.storeId,
        billAmount: num(referral.billAmount),
        diamondDiscountPct: num(referral.diamondDiscountPct),
        diamondDiscountAmount: num(referral.diamondDiscountAmount),
        commissionPct: num(referral.commissionPct),
        commissionAmount: num(referral.commissionAmount),
        invoiceNo: referral.invoiceNo ?? null,
        billDate: referral.billDate ? referral.billDate.toISOString().slice(0, 10) : null,
        codeBalanceAfter: num(updated.commissionBalance),
        usesAfter: updated.uses,
        createdAt: referral.createdAt.toISOString(),
      };
    });
  }

  /** GET /loyalty/referrals?codeId= — referrals for a code (scope-checked). */
  async referrals(user: AuthUser, codeId: string | undefined, headerStore?: string) {
    if (codeId) {
      const code = await this.prisma.referralCode.findFirst({
        where: { id: codeId, ...this.scopedWhere(user, headerStore) },
      });
      if (!code) throw new NotFoundException('referral code not found');
    }
    // Referral has no organisationId column of its own, so it cannot take the
    // org-bound scopedWhere directly — org-bind it through its parent code
    // relation while preserving the exact store-scope semantics (referral.storeId).
    const rows = await this.prisma.referral.findMany({
      where: codeId
        ? { codeId }
        : {
            code: { organisationId: user.organisationId },
            OR: [this.scope.storeFilter(user, headerStore), { storeId: null }],
          },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      codeId: r.codeId,
      refereeName: r.refereeName,
      refereePhone: r.refereePhone ?? '',
      storeId: r.storeId,
      billAmount: num(r.billAmount),
      diamondDiscountPct: num(r.diamondDiscountPct),
      diamondDiscountAmount: num(r.diamondDiscountAmount),
      commissionPct: num(r.commissionPct),
      commissionAmount: num(r.commissionAmount),
      invoiceNo: r.invoiceNo ?? null,
      billDate: r.billDate ? r.billDate.toISOString().slice(0, 10) : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * POST /loyalty/referral-codes/:id/payout — redeem / cash out accrued commission.
   * 400 if amount exceeds the balance; otherwise records the payout and draws the
   * balance down atomically.
   */
  async payout(user: AuthUser, id: string, dto: ReferralPayoutDto) {
    return this.prisma.$transaction(async (tx) => {
      const code = await tx.referralCode.findUnique({ where: { id } });
      if (!code) throw new NotFoundException('referral code not found');
      // findUnique bypasses scopedWhere, so a company-wide (null-store) code from
      // another org would pass the store gate below. Fence to the caller's org
      // first: HO of org A must not draw down org B's company-wide code.
      this.scope.assertOrgAllowed(user, code.organisationId);
      this.assertCodeAccess(user, code.storeId);
      // A null-store code is company-wide — only head office may pay it out.
      if (code.storeId == null && user.role !== 'head_office') {
        throw new ForbiddenException(
          'Only head office may pay out company-wide referral codes',
        );
      }

      const amount = new Prisma.Decimal(dto.amount);
      if (amount.greaterThan(code.commissionBalance)) {
        throw new BadRequestException('amount exceeds commission balance');
      }

      const payout = await tx.referralPayout.create({
        data: { codeId: id, amount, type: dto.type, invoiceNo: dto.invoiceNo },
      });
      const updated = await tx.referralCode.update({
        where: { id },
        data: { commissionBalance: { decrement: amount } },
      });

      return {
        id: payout.id,
        codeId: payout.codeId,
        type: payout.type,
        amount: num(payout.amount),
        invoiceNo: payout.invoiceNo ?? null,
        balanceAfter: num(updated.commissionBalance),
        createdAt: payout.createdAt.toISOString(),
      };
    });
  }

  /**
   * GET /loyalty/referral-codes/:id/wallet — full wallet view for one code:
   * the code header, its referrals (earnings) and payouts (redemptions) newest
   * first, plus Decimal-safe totals. Scope-checked via scopedWhere.
   */
  async wallet(user: AuthUser, id: string, headerStore?: string) {
    const code = await this.prisma.referralCode.findFirst({
      where: { id, ...this.scopedWhere(user, headerStore) },
    });
    if (!code) throw new NotFoundException('referral code not found');

    const [referrals, payouts] = await Promise.all([
      this.prisma.referral.findMany({
        where: { codeId: id },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.referralPayout.findMany({
        where: { codeId: id },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const totalWallet = referrals.reduce(
      (acc, r) => acc.add(r.commissionAmount),
      new Prisma.Decimal(0),
    );
    const redeemed = payouts.reduce(
      (acc, p) => acc.add(p.amount),
      new Prisma.Decimal(0),
    );

    return {
      code: {
        id: code.id,
        code: code.code,
        referrerName: code.referrerName,
        referrerPhone: code.referrerPhone ?? '',
        commissionBalance: num(code.commissionBalance),
      },
      referrals: referrals.map((r) => ({
        id: r.id,
        refereeName: r.refereeName,
        billDate: r.billDate ? r.billDate.toISOString().slice(0, 10) : null,
        invoiceNo: r.invoiceNo ?? null,
        billAmount: num(r.billAmount),
        commissionAmount: num(r.commissionAmount),
        createdAt: r.createdAt.toISOString(),
      })),
      payouts: payouts.map((p) => ({
        id: p.id,
        type: p.type,
        invoiceNo: p.invoiceNo ?? null,
        amount: num(p.amount),
        createdAt: p.createdAt.toISOString(),
      })),
      totals: {
        totalWallet: num(totalWallet),
        redeemed: num(redeemed),
        balance: num(code.commissionBalance),
      },
    };
  }
}
