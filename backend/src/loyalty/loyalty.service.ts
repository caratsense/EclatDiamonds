import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import {
  CreateReferralCodeDto,
  CreateReferralDto,
  EnrollMemberDto,
  ReferralPayoutDto,
} from './dto/loyalty.dto';

function num(v: Prisma.Decimal | number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

// Module 17 "Earn with Ratanlall" defaults (client rules, CLIENT-CALL-2026-07).
/** Diamond discount the referee (Y) receives, as a percent of the bill. */
const DIAMOND_DISCOUNT_PCT = 5;
/** Commission the referrer (X) earns, as a percent of the referee's total bill. */
const COMMISSION_PCT = 5;

/** billAmount * pct/100, rounded to whole paise (2dp) — exact Decimal math. */
function pctOf(bill: Prisma.Decimal, pct: number): Prisma.Decimal {
  return bill.mul(new Prisma.Decimal(pct)).div(100).toDecimalPlaces(2);
}

@Injectable()
export class LoyaltyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
  ) {}

  /** GET /loyalty/plans — scheme-plan templates (not store-scoped). */
  async plans() {
    const plans = await this.prisma.schemePlan.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    return plans.map((p) => ({
      id: p.id,
      name: p.name,
      tenureMonths: p.tenureMonths,
      bonusMonths: p.bonusMonths,
      bonusLabel: p.bonusLabel ?? '',
    }));
  }

  /** GET /loyalty/members — enrolled accounts with paid/missed installments + maturity. */
  async members(user: AuthUser, headerStore?: string) {
    const rows = await this.prisma.schemeMember.findMany({
      where: this.scope.storeFilter(user, headerStore),
      include: { installments: true },
      orderBy: { enrolledAt: 'desc' },
    });
    const now = Date.now();
    return rows.map((m) => {
      const paidMonths = m.installments.filter((i) => i.status === 'paid').length;
      const missedMonths = m.installments.filter(
        (i) => i.status === 'missed' || (i.status === 'due' && i.dueDate.getTime() < now),
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
    const plan = await this.prisma.schemePlan.findUnique({ where: { id: dto.planId } });
    if (!plan) throw new NotFoundException('Scheme plan not found');

    const year = new Date().getFullYear();
    const count = await this.prisma.schemeMember.count();
    const enrolledAt = new Date();

    const member = await this.prisma.schemeMember.create({
      data: {
        ref: `GSS-${year}-${3001 + count}`,
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
            dueDate: new Date(enrolledAt.getFullYear(), enrolledAt.getMonth() + i, enrolledAt.getDate()),
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
  // MODULE 17 — "Earn with Ratanlall" referral / commission program
  // ==========================================================================

  /**
   * Scope fragment for referral codes/referrals: the user's scoped stores plus
   * null-store (company-wide) rows, which everyone in scope may see. HO = no filter.
   * Mirrors the ticketing pattern for nullable-store entities.
   */
  private scopedWhere(user: AuthUser, headerStore?: string) {
    const f = this.scope.storeFilter(user, headerStore);
    if (Object.keys(f).length === 0) return {}; // head_office
    return { OR: [f, { storeId: null }] };
  }

  /** A store-bound code is gated by scope; a company-wide (null-store) code is open. */
  private assertCodeAccess(user: AuthUser, storeId: string | null): void {
    if (storeId) this.scope.assertStoreAllowed(user, storeId);
  }

  /** Readable uppercase slug from the referrer's name, e.g. "Ratan Lall" -> "RATANLALL". */
  private codeSlug(name: string): string {
    const base = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    return base || 'REF';
  }

  /**
   * Generate a unique, human-readable code: name-slug + a short crypto suffix.
   * Retries on the (extremely unlikely) @unique collision. No Math.random/Date.now.
   */
  private async generateCode(name: string): Promise<string> {
    const slug = this.codeSlug(name);
    for (let attempt = 0; attempt < 8; attempt++) {
      const suffix = randomBytes(3).toString('hex').toUpperCase(); // 6 hex chars
      const code = `${slug}-${suffix}`;
      const clash = await this.prisma.referralCode.findUnique({ where: { code } });
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
    if (dto.storeId) this.scope.assertStoreAllowed(user, dto.storeId);
    const code = await this.generateCode(dto.referrerName);
    const row = await this.prisma.referralCode.create({
      data: {
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

    const diamondDiscountPct = dto.diamondDiscountPct ?? DIAMOND_DISCOUNT_PCT;
    const commissionPct = dto.commissionPct ?? COMMISSION_PCT;
    const bill = new Prisma.Decimal(dto.billAmount);
    const diamondDiscountAmount = pctOf(bill, diamondDiscountPct);
    const commissionAmount = pctOf(bill, commissionPct);

    return this.prisma.$transaction(async (tx) => {
      const code = await tx.referralCode.findUnique({ where: { code: dto.code } });
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
    const rows = await this.prisma.referral.findMany({
      where: codeId ? { codeId } : this.scopedWhere(user, headerStore),
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
      this.assertCodeAccess(user, code.storeId);

      const amount = new Prisma.Decimal(dto.amount);
      if (amount.greaterThan(code.commissionBalance)) {
        throw new BadRequestException('amount exceeds commission balance');
      }

      const payout = await tx.referralPayout.create({
        data: { codeId: id, amount, type: dto.type },
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
        balanceAfter: num(updated.commissionBalance),
        createdAt: payout.createdAt.toISOString(),
      };
    });
  }
}
