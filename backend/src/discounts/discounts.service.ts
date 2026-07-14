import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DiscountStatus, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { AuditService } from '../common/audit.service';
import { ROLE_RANK, canSeeCost } from '../common/role.util';
import {
  CreateDiscountRequestDto,
  SetDiscountLimitDto,
} from './dto/discount.dto';

type Caps = { diamond: number; making: number };

/**
 * Module 15 role-aware serializer. Cost price and margin are surfaced ONLY to
 * area_manager / head_office. store_manager and salesperson responses MUST NOT
 * contain costPrice, margin, or marginImpact under any circumstance.
 */
function toView(d: any, viewerRole: Role) {
  const base = {
    id: d.id,
    ref: d.ref,
    storeId: d.storeId,
    customer: d.customerName,
    item: d.item ?? '',
    // Gold is never discounted — only diamond% and making%.
    diamondPercent: d.diamondPercent != null ? Number(d.diamondPercent) : 0,
    makingPercent: d.makingPercent != null ? Number(d.makingPercent) : 0,
    percent: d.percent != null ? Number(d.percent) : 0,
    amount: d.amount != null ? Number(d.amount) : 0,
    sellingPrice: d.sellingPrice != null ? Number(d.sellingPrice) : null,
    status: d.status,
    reason: d.reason ?? '',
    decisionNote: d.decisionNote ?? null,
    requestedRole: d.requestedRole,
    requiredRole: d.requiredRole ?? null,
    approvedRole: d.approvedRole,
    createdAt: d.createdAt.toISOString().slice(0, 10),
  };

  // COST/MARGIN GATE (security-critical): area_manager & head_office only.
  if (canSeeCost(viewerRole)) {
    const selling = d.sellingPrice != null ? Number(d.sellingPrice) : null;
    const cost = d.costPrice != null ? Number(d.costPrice) : null;
    return {
      ...base,
      costPrice: cost,
      margin: selling != null && cost != null ? Number((selling - cost).toFixed(2)) : null,
      marginImpact: d.marginImpact != null ? Number(d.marginImpact) : 0,
    };
  }

  // store_manager / salesperson: no cost, no margin, no marginImpact.
  return base;
}

function limitView(l: any) {
  return {
    id: l.id,
    role: l.role,
    storeId: l.storeId,
    maxDiamondPercent: l.maxDiamondPercent != null ? Number(l.maxDiamondPercent) : null,
    maxMakingPercent: l.maxMakingPercent != null ? Number(l.maxMakingPercent) : null,
    maxPercent: Number(l.maxPercent),
    maxAmount: l.maxAmount != null ? Number(l.maxAmount) : null,
  };
}

@Injectable()
export class DiscountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser, headerStore?: string) {
    const rows = await this.prisma.discountRequest.findMany({
      where: this.scope.storeFilter(user, headerStore),
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => toView(r, user.role));
  }

  /**
   * Module 15 create. Gold is never discounted — only diamond% and making%.
   * Within the requester role's caps => auto-approved. Over caps => escalated to
   * the lowest role whose caps cover BOTH percentages (area_manager, else head_office),
   * with `requiredRole` set. Snapshots selling/cost price + margin impact.
   */
  async create(user: AuthUser, dto: CreateDiscountRequestDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);

    const caps = await this.loadCaps(dto.storeId);
    const diamondPercent = dto.diamondPercent ?? 0;
    const makingPercent = dto.makingPercent ?? 0;

    // Snapshot selling & cost price (from the linked product if given).
    let sellingPrice = dto.sellingPrice ?? null;
    let costPrice: number | null = null;
    if (dto.productId) {
      const product = await this.prisma.product.findUnique({ where: { id: dto.productId } });
      if (product) {
        if (sellingPrice == null && product.price != null) sellingPrice = Number(product.price);
        if (product.costPrice != null) costPrice = Number(product.costPrice);
      }
    }

    // Margin impact (INR) = the rupee hit to margin from the discount.
    const overallPct = dto.percent ?? Math.max(diamondPercent, makingPercent);
    const discountAmount =
      dto.amount ?? (sellingPrice != null ? Number(((sellingPrice * overallPct) / 100).toFixed(2)) : null);
    const marginImpact = dto.marginImpact ?? discountAmount;

    // Escalation decision.
    const requesterCaps = caps[user.role] ?? { diamond: 0, making: 0 };
    const withinOwn = diamondPercent <= requesterCaps.diamond && makingPercent <= requesterCaps.making;

    let status: DiscountStatus;
    let requiredRole: Role;
    if (withinOwn) {
      status = 'approved';
      requiredRole = user.role;
    } else {
      status = 'escalated';
      requiredRole = this.findApprover(user.role, diamondPercent, makingPercent, caps);
    }

    const count = await this.prisma.discountRequest.count();
    const row = await this.prisma.discountRequest.create({
      data: {
        ref: `DR-${1000 + count + 1}`,
        storeId: dto.storeId,
        customerName: dto.customerName,
        item: dto.item,
        diamondPercent: new Prisma.Decimal(diamondPercent),
        makingPercent: new Prisma.Decimal(makingPercent),
        percent: dto.percent != null ? new Prisma.Decimal(dto.percent) : null,
        amount: dto.amount != null ? new Prisma.Decimal(dto.amount) : null,
        sellingPrice: sellingPrice != null ? new Prisma.Decimal(sellingPrice) : null,
        costPrice: costPrice != null ? new Prisma.Decimal(costPrice) : null,
        marginImpact: marginImpact != null ? new Prisma.Decimal(marginImpact) : null,
        reason: dto.reason,
        status,
        requestedById: user.id,
        requestedRole: user.role,
        requiredRole,
        approvedById: status === 'approved' ? user.id : null,
        approvedRole: status === 'approved' ? user.role : null,
        decidedAt: status === 'approved' ? new Date() : null,
      },
    });
    return toView(row, user.role);
  }

  /** Approve a pending/escalated request. Only a role ranked >= requiredRole may act. */
  async approve(user: AuthUser, id: string, reason?: string, note?: string) {
    return this.decide(user, id, 'approved', reason, note);
  }

  /** Reject a pending/escalated request. Only a role ranked >= requiredRole may act. */
  async reject(user: AuthUser, id: string, reason?: string, note?: string) {
    return this.decide(user, id, 'rejected', reason, note);
  }

  private async decide(
    user: AuthUser,
    id: string,
    decision: DiscountStatus,
    reason?: string,
    note?: string,
  ) {
    const row = await this.prisma.discountRequest.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Discount request not found');

    // Only undecided requests may be decided — no flipping a settled decision.
    if (row.status !== 'pending' && row.status !== 'escalated') {
      throw new BadRequestException('This request has already been decided');
    }

    // Store-scoping: the approver must have this store in scope.
    this.scope.assertStoreAllowed(user, row.storeId);

    // Role gate: the acting role must outrank (or equal) the required approver role.
    const required = (row.requiredRole ?? row.requestedRole ?? 'head_office') as Role;
    if (ROLE_RANK[user.role] < ROLE_RANK[required]) {
      throw new ForbiddenException(`This request requires ${required} approval`);
    }

    const updated = await this.prisma.discountRequest.update({
      where: { id },
      data: {
        status: decision,
        approvedById: user.id,
        approvedRole: user.role,
        decidedAt: new Date(),
        reason: reason ?? row.reason,
        decisionNote: note ?? row.decisionNote,
      },
    });

    const pct =
      row.percent != null
        ? Number(row.percent)
        : Math.max(Number(row.diamondPercent ?? 0), Number(row.makingPercent ?? 0));
    await this.audit.record(user, {
      action: decision === 'approved' ? 'discount.approve' : 'discount.reject',
      entityType: 'DiscountRequest',
      entityId: updated.id,
      storeId: updated.storeId,
      summary: `${decision === 'approved' ? 'Approved' : 'Rejected'} discount ${
        updated.ref
      } (${pct}%) for ${updated.customerName}`,
      metadata: { note: note ?? null },
    });

    return toView(updated, user.role);
  }

  /** View the configured caps (area_manager / head_office). */
  async listLimits() {
    const rows = await this.prisma.discountLimit.findMany({
      orderBy: [{ storeId: 'asc' }, { role: 'asc' }],
    });
    return rows.map(limitView);
  }

  /** head_office: set/override a global or store-scoped role cap. */
  async setLimit(user: AuthUser, dto: SetDiscountLimitDto) {
    const storeId = dto.storeId ?? null;
    const existing = await this.prisma.discountLimit.findFirst({ where: { role: dto.role, storeId } });

    const diamond = dto.maxDiamondPercent != null ? new Prisma.Decimal(dto.maxDiamondPercent) : undefined;
    const making = dto.maxMakingPercent != null ? new Prisma.Decimal(dto.maxMakingPercent) : undefined;
    const amount = dto.maxAmount != null ? new Prisma.Decimal(dto.maxAmount) : undefined;

    let result: ReturnType<typeof limitView>;
    if (existing) {
      const row = await this.prisma.discountLimit.update({
        where: { id: existing.id },
        data: {
          maxDiamondPercent: diamond,
          maxMakingPercent: making,
          maxAmount: amount,
          ...(dto.maxPercent != null ? { maxPercent: new Prisma.Decimal(dto.maxPercent) } : {}),
        },
      });
      result = limitView(row);
    } else {
      // Create requires a non-null maxPercent; default to the larger split cap.
      const overall = dto.maxPercent ?? Math.max(dto.maxDiamondPercent ?? 0, dto.maxMakingPercent ?? 0);
      const row = await this.prisma.discountLimit.create({
        data: {
          role: dto.role,
          storeId,
          maxPercent: new Prisma.Decimal(overall),
          maxDiamondPercent: diamond,
          maxMakingPercent: making,
          maxAmount: amount,
        },
      });
      result = limitView(row);
    }

    await this.audit.record(user, {
      action: 'discount_limit.change',
      entityType: 'DiscountLimit',
      entityId: result.id,
      storeId,
      summary: `Set ${dto.role} discount cap${storeId ? ` for store ${storeId}` : ' (global)'}`,
      metadata: {
        role: dto.role,
        maxDiamondPercent: dto.maxDiamondPercent ?? null,
        maxMakingPercent: dto.maxMakingPercent ?? null,
        maxPercent: dto.maxPercent ?? null,
        maxAmount: dto.maxAmount ?? null,
      },
    });

    return result;
  }

  /**
   * Load per-role diamond/making caps for a store (store-scoped row overrides the
   * global storeId=null default). Falls back to maxPercent when a split cap is null.
   */
  private async loadCaps(storeId: string): Promise<Record<Role, Caps>> {
    const rows = await this.prisma.discountLimit.findMany({
      where: { OR: [{ storeId }, { storeId: null }] },
    });
    const byRole: Partial<Record<Role, any>> = {};
    for (const r of rows) {
      const cur = byRole[r.role];
      // Prefer the store-scoped row over the global (null) one.
      if (!cur || (cur.storeId === null && r.storeId !== null)) byRole[r.role] = r;
    }

    const caps = {} as Record<Role, Caps>;
    for (const role of Object.keys(ROLE_RANK) as Role[]) {
      const row = byRole[role];
      if (!row) {
        // Safety net: head_office always has full authority even if unseeded.
        caps[role] = role === 'head_office' ? { diamond: 100, making: 100 } : { diamond: 0, making: 0 };
        continue;
      }
      const overall = Number(row.maxPercent);
      caps[role] = {
        diamond: row.maxDiamondPercent != null ? Number(row.maxDiamondPercent) : overall,
        making: row.maxMakingPercent != null ? Number(row.maxMakingPercent) : overall,
      };
    }
    return caps;
  }

  /** Lowest role ranked above the requester whose caps cover BOTH percentages; else head_office. */
  private findApprover(requester: Role, diamondPercent: number, makingPercent: number, caps: Record<Role, Caps>): Role {
    const ordered = (Object.keys(ROLE_RANK) as Role[]).sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b]);
    for (const role of ordered) {
      if (ROLE_RANK[role] <= ROLE_RANK[requester]) continue;
      const c = caps[role];
      if (c && diamondPercent <= c.diamond && makingPercent <= c.making) return role;
    }
    return 'head_office';
  }
}
