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
import { SequenceService } from '../common/sequence.service';
import { NotificationsService } from '../notifications/notifications.service';
import { assertNotSelfApproval, assertUndecided, decisionStamp } from '../common/approval.util';
import { ROLE_LABELS, ROLE_RANK, canSeeCost } from '../common/role.util';
import {
  CreateDiscountRequestDto,
  SetDiscountLimitDto,
} from './dto/discount.dto';

/** Per-role caps. `overall` is DiscountLimit.maxPercent, the cap on a quote discount. */
type Caps = { diamond: number; making: number; overall: number };

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
    // The manual sale this approval has been billed to, if any — lets the UI show
    // approved-but-unbilled requests as "ready to bill" (direct-sale over-cap flow).
    saleId: d.sale?.id ?? null,
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
    private readonly sequence: SequenceService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(user: AuthUser, headerStore?: string) {
    const where: Prisma.DiscountRequestWhereInput = {
      ...this.scope.storeFilter(user, headerStore),
    };
    // A salesperson only ever sees the discount requests they raised; store_manager+
    // see every in-scope request (mirrors the leads ownership rule).
    if (user.role === 'salesperson') where.requestedById = user.id;
    const rows = await this.prisma.discountRequest.findMany({
      where,
      include: { sale: { select: { id: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => toView(r, user.role));
  }

  /** GET /discounts/presets — return preset discount codes list (seeds default if empty). */
  async listPresets(user: AuthUser) {
    const organisationId = user.organisationId;
    let presets = await this.prisma.discountPreset.findMany({
      where: { isActive: true, organisationId },
      orderBy: { code: 'asc' },
    });
    if (presets.length === 0) {
      const defaults = [
        { code: 'D10', name: '10% Diamond Discount', diamondPercent: new Prisma.Decimal(10), makingPercent: new Prisma.Decimal(0), description: 'Flat 10% on diamond value' },
        { code: 'D15', name: '15% Diamond Discount', diamondPercent: new Prisma.Decimal(15), makingPercent: new Prisma.Decimal(0), description: 'Flat 15% on diamond value' },
        { code: 'D20', name: '20% Diamond Discount', diamondPercent: new Prisma.Decimal(20), makingPercent: new Prisma.Decimal(0), description: 'Flat 20% on diamond value' },
        { code: 'D25', name: '25% Diamond Discount', diamondPercent: new Prisma.Decimal(25), makingPercent: new Prisma.Decimal(0), description: 'Flat 25% on diamond value' },
        { code: 'M5', name: '5% Making Charge Discount', diamondPercent: new Prisma.Decimal(0), makingPercent: new Prisma.Decimal(5), description: '5% off making charges' },
        { code: 'M10', name: '10% Making Charge Discount', diamondPercent: new Prisma.Decimal(0), makingPercent: new Prisma.Decimal(10), description: '10% off making charges' },
        { code: 'M15', name: '15% Making Charge Discount', diamondPercent: new Prisma.Decimal(0), makingPercent: new Prisma.Decimal(15), description: '15% off making charges' },
        { code: 'D10_M5', name: '10% Diamond + 5% Making', diamondPercent: new Prisma.Decimal(10), makingPercent: new Prisma.Decimal(5), description: '10% on diamond + 5% on making' },
        { code: 'D10_M10', name: '10% Diamond + 10% Making', diamondPercent: new Prisma.Decimal(10), makingPercent: new Prisma.Decimal(10), description: '10% on diamond + 10% on making' },
        { code: 'D15_M10', name: '15% Diamond + 10% Making', diamondPercent: new Prisma.Decimal(15), makingPercent: new Prisma.Decimal(10), description: '15% on diamond + 10% on making' },
        { code: 'D20_M10', name: '20% Diamond + 10% Making', diamondPercent: new Prisma.Decimal(20), makingPercent: new Prisma.Decimal(10), description: '20% on diamond + 10% on making' },
      ];
      await this.prisma.discountPreset.createMany({
        data: defaults.map((d) => ({ ...d, organisationId })),
      });
      presets = await this.prisma.discountPreset.findMany({
        where: { isActive: true, organisationId },
        orderBy: { code: 'asc' },
      });
    }
    return presets.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      diamondPercent: p.diamondPercent != null ? Number(p.diamondPercent) : 0,
      makingPercent: p.makingPercent != null ? Number(p.makingPercent) : 0,
      overallPercent: p.overallPercent != null ? Number(p.overallPercent) : 0,
      description: p.description ?? '',
    }));
  }

  /**
   * Module 15 create. Gold is never discounted — only diamond% and making%.
   * Within the requester role's caps => auto-approved. Over caps => escalated to
   * the lowest role whose caps cover BOTH percentages (area_manager, else head_office),
   * with `requiredRole` set. Snapshots selling/cost price + margin impact.
   */
  async create(user: AuthUser, dto: CreateDiscountRequestDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);

    const caps = await this.loadCaps(user.organisationId, dto.storeId);
    const diamondPercent = dto.diamondPercent ?? dto.percent ?? 0;
    const makingPercent = dto.makingPercent ?? dto.percent ?? 0;

    // Snapshot selling & cost price (from the linked product if given).
    let sellingPrice = dto.sellingPrice ?? null;
    let costPrice: number | null = null;
    if (dto.productId) {
      // Org-scope the lookup: a foreign productId must not snapshot another
      // tenant's price/cost (margin leak) — treat it as an invalid reference.
      const product = await this.prisma.product.findFirst({
        where: { id: dto.productId, organisationId: user.organisationId },
      });
      if (!product) throw new NotFoundException('Product not found');
      if (sellingPrice == null && product.price != null) sellingPrice = Number(product.price);
      if (product.costPrice != null) costPrice = Number(product.costPrice);
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

    // Sequence-backed ref: `count() + 1` handed the same number to two
    // salespeople approving concurrently, and re-used numbers after a deletion.
    const seq = await this.sequence.next('DR:global');
    const row = await this.prisma.discountRequest.create({
      data: {
        organisationId: user.organisationId,
        ref: `DR-${1000 + seq}`,
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

    // An escalated request that nobody is told about is a request that sits.
    if (status === 'escalated') {
      await this.notifications.emitToApprovers(
        dto.storeId,
        requiredRole,
        {
          kind: 'discount_request',
          title: `Discount approval needed — ${row.ref}`,
          body: `${user.name} requested ${diamondPercent}% diamond / ${makingPercent}% making for ${dto.customerName}`,
          href: '/approvals',
          storeId: dto.storeId,
          entityType: 'DiscountRequest',
          entityId: row.id,
          priority: 'high',
          actorId: user.id,
          actorName: user.name,
          dedupeKey: `discount:${row.id}:raised`,
          metadata: { ref: row.ref, diamondPercent, makingPercent, requiredRole },
        },
        user.id,
      );
    }

    return toView(row, user.role);
  }

  /**
   * Shared Module 15 cap evaluation — reused by the discount-request workflow AND
   * direct-sale enforcement so the diamond/making caps live in ONE place (no
   * duplicated cap logic). Returns whether the requester may self-approve the
   * given split, and if not, the lowest role that must approve (escalation target).
   */
  async evaluateDiscount(
    user: AuthUser,
    storeId: string,
    diamondPercent: number,
    makingPercent: number,
  ): Promise<{ withinOwn: boolean; requiredRole: Role }> {
    const caps = await this.loadCaps(user.organisationId, storeId);
    const own = caps[user.role] ?? { diamond: 0, making: 0 };
    const withinOwn =
      diamondPercent <= own.diamond && makingPercent <= own.making;
    const requiredRole = withinOwn
      ? user.role
      : this.findApprover(user.role, diamondPercent, makingPercent, caps);
    return { withinOwn, requiredRole };
  }

  /**
   * The cap on a single overall discount percentage — what a quote carries.
   *
   * Reads the same DiscountLimit rows, per role with a store row overriding the
   * global one, and escalates the same way; it answers from `maxPercent` rather
   * than the diamond/making split, because a quote discount is one figure taken
   * off making and diamond together (never gold).
   *
   * Takes the role explicitly: a quote is judged against whoever PRICED it,
   * not whoever is asking. `configured` is false when this tenant has no
   * DiscountLimit rows at all — a tenant that never set caps has no discount
   * rule for a quote to break.
   */
  async evaluateOverall(
    organisationId: string,
    storeId: string,
    role: Role,
    percent: number,
  ): Promise<{ configured: boolean; withinOwn: boolean; requiredRole: Role; cap: number }> {
    const { caps, configured } = await this.loadCapsWithState(organisationId, storeId);
    const cap = caps[role]?.overall ?? 0;
    const withinOwn = percent <= cap;
    const requiredRole = withinOwn
      ? role
      : this.firstApprover(role, caps, (c) => percent <= c.overall);
    return { configured, withinOwn, requiredRole, cap };
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
    assertUndecided(row.status, ['approved', 'rejected'], 'discount request');

    // Store-scoping: the approver must have this store in scope.
    this.scope.assertStoreAllowed(user, row.storeId);

    // Role gate: the acting role must outrank (or equal) the required approver role.
    const required = (row.requiredRole ?? row.requestedRole ?? 'head_office') as Role;
    if (ROLE_RANK[user.role] < ROLE_RANK[required]) {
      throw new ForbiddenException(`This request requires ${required} approval`);
    }

    // Separation of duties. The escalation ladder alone does not guarantee this:
    // a head_office requester escalates to head_office (there is nothing above
    // it) and would otherwise sign off their own margin give-away.
    assertNotSelfApproval(user, row.requestedById, 'discount request');

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

    // Close the loop with whoever raised it — previously they only found out by
    // re-opening the approvals screen and noticing the row had moved.
    if (row.requestedById) {
      await this.notifications.emit([row.requestedById], {
        kind: 'discount_request',
        title: `Discount ${updated.ref} ${decision}`,
        body: `${pct}% for ${updated.customerName} — ${decision} by ${user.name} (${
          ROLE_LABELS[user.role]
        })${note?.trim() ? `: ${note.trim()}` : ''}`,
        href: '/approvals',
        storeId: updated.storeId,
        entityType: 'DiscountRequest',
        entityId: updated.id,
        priority: decision === 'rejected' ? 'high' : 'normal',
        actorId: user.id,
        actorName: user.name,
        dedupeKey: `discount:${updated.id}:decided`,
        metadata: { status: decision },
      });
    }

    return toView(updated, user.role);
  }

  /** View the configured caps (area_manager / head_office). */
  async listLimits(user: AuthUser) {
    const rows = await this.prisma.discountLimit.findMany({
      where: this.scope.orgFilter(user),
      orderBy: [{ storeId: 'asc' }, { role: 'asc' }],
    });
    return rows.map(limitView);
  }

  /** head_office: set/override a global or store-scoped role cap. */
  async setLimit(user: AuthUser, dto: SetDiscountLimitDto) {
    const storeId = dto.storeId ?? null;
    if (storeId) this.scope.assertStoreAllowed(user, storeId);
    const organisationId = user.organisationId;
    const existing = await this.prisma.discountLimit.findFirst({
      where: { role: dto.role, storeId, organisationId },
    });

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
          organisationId,
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
  private async loadCaps(organisationId: string, storeId: string): Promise<Record<Role, Caps>> {
    return (await this.loadCapsWithState(organisationId, storeId)).caps;
  }

  private async loadCapsWithState(
    organisationId: string,
    storeId: string,
  ): Promise<{ caps: Record<Role, Caps>; configured: boolean }> {
    const rows = await this.prisma.discountLimit.findMany({
      where: { organisationId, OR: [{ storeId }, { storeId: null }] },
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
        caps[role] =
          role === 'head_office'
            ? { diamond: 100, making: 100, overall: 100 }
            : { diamond: 0, making: 0, overall: 0 };
        continue;
      }
      const overall = Number(row.maxPercent);
      caps[role] = {
        diamond: row.maxDiamondPercent != null ? Number(row.maxDiamondPercent) : overall,
        making: row.maxMakingPercent != null ? Number(row.maxMakingPercent) : overall,
        overall,
      };
    }
    return { caps, configured: rows.length > 0 };
  }

  /** Lowest role ranked above the requester whose caps cover BOTH percentages; else head_office. */
  private findApprover(requester: Role, diamondPercent: number, makingPercent: number, caps: Record<Role, Caps>): Role {
    return this.firstApprover(
      requester,
      caps,
      (c) => diamondPercent <= c.diamond && makingPercent <= c.making,
    );
  }

  /** Lowest role ranked above the requester whose caps satisfy `covers`; else head_office. */
  private firstApprover(requester: Role, caps: Record<Role, Caps>, covers: (c: Caps) => boolean): Role {
    const ordered = (Object.keys(ROLE_RANK) as Role[]).sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b]);
    for (const role of ordered) {
      if (ROLE_RANK[role] <= ROLE_RANK[requester]) continue;
      // area_manager was collapsed into store_manager — it is a dead approver tier
      if (role === 'area_manager') continue;
      const c = caps[role];
      if (c && covers(c)) return role;
    }
    return 'head_office';
  }
}
