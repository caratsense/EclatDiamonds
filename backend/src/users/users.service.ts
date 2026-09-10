import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { StoreScopeService } from '../common/store-scope.service';
import { ROLE_RANK } from '../common/role.util';
import { WhatsAppIdentityService } from '../whatsapp-bot/whatsapp-identity.service';
import { canApproveSignup, uniqueEmailHandle } from './users.util';
import {
  ApproveUserDto,
  CreateUserDto,
  DeactivateUserDto,
  SetLeaveAllocationDto,
  UpdateUserRoleDto,
  UpdateUserStoreDto,
} from './dto/users.dto';

/** Pull each user's store assignments (for the staff list). */
const USER_INCLUDE = {
  userStores: {
    include: { store: { select: { id: true, name: true } } },
    orderBy: { isPrimary: 'desc' as const },
  },
} as const;

/** Two-letter initials fallback for a freshly-provisioned login. */
function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || name.slice(0, 2).toUpperCase()
  );
}

/** Last 10 digits of a phone (Indian mobile) — same rule the OTP login matches on. */
function last10(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scope: StoreScopeService,
    private readonly whatsappIdentity: WhatsAppIdentityService,
  ) {}

  // ── Delegation / privilege-escalation guards ───────────────────────────────
  // These two helpers are THE security core: every mutation runs through them so
  // a user can only ever provision/modify principals STRICTLY BELOW their own
  // rank, inside their own store scope. head_office (allStores) bypasses scope
  // but is still bound by the strictly-below-rank rule (it can never mint an HO).

  /**
   * A user may only assign/target a role strictly below their own rank, and
   * `head_office` is never assignable by anyone.
   */
  private assertAssignableRole(actor: AuthUser, role: Role): void {
    if (role === 'head_office') {
      throw new ForbiddenException('head_office cannot be assigned');
    }
    if (ROLE_RANK[role] >= ROLE_RANK[actor.role]) {
      throw new ForbiddenException('You can only assign roles below your own');
    }
  }

  /**
   * A user may only modify a target whose CURRENT role is strictly below their
   * own (never a peer or a superior), and — for scoped (non-HO) actors — only
   * when the target's store is inside their scope. Pass `storeId=null/undefined`
   * to skip the store check (e.g. a not-yet-assigned user).
   */
  private assertCanManage(actor: AuthUser, targetRole: Role, storeId?: string | null): void {
    if (ROLE_RANK[targetRole] >= ROLE_RANK[actor.role]) {
      throw new ForbiddenException('You cannot manage a user at or above your own role');
    }
    if (storeId) {
      this.scope.assertStoreAllowed(actor, storeId);
    }
  }

  /** The target's primary store (falls back to any assignment) — for scope gating. */
  private async primaryStoreId(userId: string): Promise<string | null> {
    const primary = await this.prisma.userStore.findFirst({
      where: { userId, isPrimary: true },
      select: { storeId: true },
    });
    if (primary) return primary.storeId;
    const any = await this.prisma.userStore.findFirst({
      where: { userId },
      select: { storeId: true },
    });
    return any?.storeId ?? null;
  }

  /**
   * Public list/detail shape. `visibleStoreIds` (undefined = all) hides store
   * assignments outside a scoped manager's reach, so the staff list can't leak
   * the names of foreign stores a cross-store user also belongs to.
   */
  private toView(user: any, visibleStoreIds?: string[]) {
    const links = (user.userStores ?? []).filter(
      (us: any) => !visibleStoreIds || visibleStoreIds.includes(us.storeId),
    );
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone ?? null,
      role: user.role as Role,
      stores: links.map((us: any) => ({
        id: us.store.id,
        name: us.store.name,
      })),
      isActive: user.isActive,
    };
  }

  /**
   * GET /users — staff with their store assignments, STORE-SCOPED.
   * head_office (no store filter) sees everyone; a scoped manager sees only
   * users assigned to a store inside their scope. A narrowing `requestedStoreId`
   * is validated against scope (throws if out of scope).
   */
  async list(actor: AuthUser, requestedStoreId?: string) {
    // Org guard: even an allStores head_office only ever sees THIS org's users.
    let where: any = { organisationId: actor.organisationId };
    let visibleStoreIds: string[] | undefined;
    if (!actor.allStores || (requestedStoreId && requestedStoreId !== 'all')) {
      const ids = this.scope.effectiveStoreIds(actor, requestedStoreId);
      where = { organisationId: actor.organisationId, userStores: { some: { storeId: { in: ids } } } };
      // Scoped actor: only reveal store links inside their scope.
      if (!actor.allStores) visibleStoreIds = ids;
    }
    const users = await this.prisma.user.findMany({
      where,
      orderBy: { name: 'asc' },
      include: USER_INCLUDE,
    });
    return users.map((u) => this.toView(u, visibleStoreIds));
  }

  /**
   * GET /users/unassigned — active users with NO store link (pending assignment),
   * so a manager can find and assign new staff. Unassigned users have no store to
   * scope by, so this is visible to any manager+ (they can only assign into their
   * own scope via PATCH /users/:id/store).
   */
  async listUnassigned(actor: AuthUser) {
    const users = await this.prisma.user.findMany({
      where: { organisationId: actor.organisationId, isActive: true, userStores: { none: {} } },
      orderBy: { name: 'asc' },
      include: USER_INCLUDE,
    });
    return users.map((u) => this.toView(u));
  }

  /**
   * POST /users — a manager onboards a staff member strictly below their rank
   * (default salesperson) and links them to a store IN THEIR SCOPE as primary.
   * They then sign in via WhatsApp OTP with their phone (matched on the last 10
   * digits) — the generated password is only a placeholder so the row is valid.
   */
  async create(actor: AuthUser, dto: CreateUserDto) {
    const role: Role = dto.role ?? 'salesperson';
    // Escalation gate FIRST: role must be below the actor and store in scope.
    this.assertAssignableRole(actor, role);
    this.scope.assertStoreAllowed(actor, dto.storeId);

    const phone = dto.phone?.trim() || null;
    // The provided email is CONTACT ONLY now (optional, not unique) — the same
    // shape as self-signup. The login identity is a generated handle below.
    const contactEmail = dto.email?.trim().toLowerCase() || null;

    // Team add requires BOTH a phone and an email (confirmed rule) — enforced
    // behind the DTO too, since a frontend-only guard is bypassable via the API.
    if (!phone || !contactEmail) {
      throw new BadRequestException('Both a phone number and an email are required');
    }
    if (!last10(phone)) {
      throw new BadRequestException('Enter a valid 10-digit mobile number');
    }

    const store = await this.prisma.store.findUnique({
      where: { id: dto.storeId },
      include: { organisation: { select: { slug: true } } },
    });
    if (!store) throw new NotFoundException('Store not found');
    if (store.isAggregate) {
      throw new BadRequestException('Cannot assign a user to the aggregate "All Stores" view');
    }

    // Login identity: a generated, unique handle — the same generator self-signup
    // uses, so every account, however created, is `firstname.storeslug@<this
    // tenant's domain>`. The person signs in with a phone OTP or, after a manager
    // sets one, this + a password.
    const email = await uniqueEmailHandle(
      dto.name,
      store.name,
      store.organisation?.slug,
      async (candidate) =>
        !!(await this.prisma.user.findUnique({ where: { email: candidate }, select: { id: true } })),
    );

    // Random password — the user logs in via OTP, or a manager resets it to share one.
    const passwordHash = await bcrypt.hash(randomBytes(24).toString('hex'), 10);

    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        email,
        contactEmail,
        phone,
        initials: initialsOf(dto.name),
        role,
        passwordHash,
        isActive: true,
        // The new staff member belongs to the actor's organisation. dto.storeId is
        // already scope-checked above, so it is a store within this same org.
        organisationId: actor.organisationId,
        userStores: {
          create: { storeId: dto.storeId, isPrimary: true },
        },
      },
      include: USER_INCLUDE,
    });

    await this.audit.record(actor, {
      action: 'user.create',
      entityType: 'User',
      entityId: user.id,
      storeId: dto.storeId,
      summary: `Provisioned ${user.name} as ${role}`,
      metadata: { role, storeId: dto.storeId },
    });

    return this.toView(user);
  }

  /** PATCH /users/:id/role — change a user's role (delegated, strictly below actor). */
  async updateRole(actor: AuthUser, id: string, dto: UpdateUserRoleDto) {
    const existing = await this.getOrThrow(actor, id);
    const storeId = await this.primaryStoreId(id);
    // Cannot touch a peer/superior or someone out of scope; new role must be below actor.
    this.assertCanManage(actor, existing.role, storeId);
    this.assertAssignableRole(actor, dto.role);

    const user = await this.prisma.user.update({
      where: { id },
      data: { role: dto.role },
      include: USER_INCLUDE,
    });

    if (existing.role !== dto.role) {
      await this.audit.record(actor, {
        action: 'user.role_change',
        entityType: 'User',
        entityId: id,
        storeId: null,
        summary: `Changed ${user.name} role: ${existing.role} → ${dto.role}`,
        metadata: { from: existing.role, to: dto.role },
      });
    }
    return this.toView(user);
  }

  /**
   * PATCH /users/:id/store — reassign the user's PRIMARY store. Demotes any other
   * primary link and upserts the target as the new primary (keeping existing links).
   * The DESTINATION store must be in the actor's scope, and — for a scoped (non-HO)
   * actor — a currently-assigned target must already have a store inside that scope
   * (you cannot poach a user assigned to a store you don't own).
   */
  async updateStore(actor: AuthUser, id: string, dto: UpdateUserStoreDto) {
    const existing = await this.getOrThrow(actor, id);
    // Rank gate: never reassign a peer/superior.
    this.assertCanManage(actor, existing.role);

    const store = await this.prisma.store.findUnique({ where: { id: dto.storeId } });
    if (!store) throw new NotFoundException('Store not found');
    if (store.isAggregate) {
      throw new BadRequestException('Cannot assign a user to the aggregate "All Stores" view');
    }
    // Destination store must be in the actor's scope.
    this.scope.assertStoreAllowed(actor, dto.storeId);

    // Target-scope gate: a scoped actor may only reassign a user who is already in
    // their scope. A user with NO links is "unassigned" — assigning them into scope
    // is allowed (that is the onboarding-from-pending flow).
    if (!actor.allStores) {
      const links = await this.prisma.userStore.findMany({
        where: { userId: id },
        select: { storeId: true },
      });
      if (links.length > 0 && !links.some((l) => actor.storeIds.includes(l.storeId))) {
        throw new ForbiddenException('User is not in your scope');
      }
    }

    // Capture the previous primary store for the audit trail.
    const prevPrimary = await this.prisma.userStore.findFirst({
      where: { userId: id, isPrimary: true },
      select: { storeId: true },
    });

    await this.prisma.$transaction([
      this.prisma.userStore.updateMany({
        where: { userId: id, isPrimary: true },
        data: { isPrimary: false },
      }),
      this.prisma.userStore.upsert({
        where: { userId_storeId: { userId: id, storeId: dto.storeId } },
        update: { isPrimary: true },
        create: { userId: id, storeId: dto.storeId, isPrimary: true },
      }),
    ]);

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id },
      include: USER_INCLUDE,
    });

    if (prevPrimary?.storeId !== dto.storeId) {
      await this.audit.record(actor, {
        action: 'user.store_change',
        entityType: 'User',
        entityId: id,
        storeId: dto.storeId,
        summary: `Reassigned ${user.name} primary store: ${
          prevPrimary?.storeId ?? 'none'
        } → ${dto.storeId}`,
        metadata: { from: prevPrimary?.storeId ?? null, to: dto.storeId },
      });
    }
    return this.toView(user);
  }

  /**
   * PATCH /users/:id/deactivate — offboard a user (never a peer/superior or someone
   * out of scope). Optionally hand off their OPEN work (owned leads + check-ins) to
   * another ACTIVE, in-scope user. Nothing is deleted — only `isActive` flips false
   * and ownership is moved.
   */
  async deactivate(actor: AuthUser, id: string, dto: DeactivateUserDto) {
    const target = await this.getOrThrow(actor, id);
    const storeId = await this.primaryStoreId(id);
    this.assertCanManage(actor, target.role, storeId);

    const reassignToId = dto.reassignToId?.trim() || null;
    let reassigned: { leads: number; checkIns: number } | null = null;

    if (reassignToId) {
      if (reassignToId === id) {
        throw new BadRequestException('Cannot hand off work to the user being deactivated');
      }
      const recipient = await this.getOrThrow(actor, reassignToId);
      if (!recipient.isActive) {
        throw new BadRequestException('Cannot hand off work to an inactive user');
      }
      // Recipient must be inside the actor's scope (HO bypasses).
      const recipientStore = await this.primaryStoreId(reassignToId);
      if (recipientStore) {
        this.scope.assertStoreAllowed(actor, recipientStore);
      } else if (!actor.allStores) {
        throw new ForbiddenException('Reassignment target is not in your scope');
      }

      // Only move work in stores the actor controls (HO = unfiltered). Prevents a
      // scoped manager's offboarding from rewriting ownership in a store outside
      // their scope (for a user assigned to multiple stores).
      const scopeWhere = actor.allStores ? {} : { storeId: { in: actor.storeIds } };
      const [leads, checkIns] = await this.prisma.$transaction([
        this.prisma.lead.updateMany({
          where: { ownerId: id, ...scopeWhere },
          data: { ownerId: reassignToId },
        }),
        this.prisma.checkIn.updateMany({
          where: { repId: id, ...scopeWhere },
          // Refresh the denormalized rep name too, so walk-ins don't keep showing
          // the departed rep.
          data: { repId: reassignToId, repName: recipient.name },
        }),
      ]);
      reassigned = { leads: leads.count, checkIns: checkIns.count };
    }

    const user = await this.prisma.user.update({
      where: { id },
      // Unlink Google so a reactivated user doesn't silently regain access.
      data: { isActive: false, googleSub: null },
      include: USER_INCLUDE,
    });

    // Revoke WhatsApp bindings too — a deactivated user's number must not keep
    // reaching the reporting bot.
    await this.whatsappIdentity.revokeForUser(id);

    await this.audit.record(actor, {
      action: 'user.deactivate',
      entityType: 'User',
      entityId: id,
      storeId,
      summary: `Deactivated ${user.name}`,
      metadata: { reassignToId },
    });

    if (reassigned) {
      await this.audit.record(actor, {
        action: 'user.reassign',
        entityType: 'User',
        entityId: id,
        storeId,
        summary: `Reassigned ${user.name}'s open work → ${reassignToId} (${reassigned.leads} leads, ${reassigned.checkIns} check-ins)`,
        metadata: { reassignToId, ...reassigned },
      });
    }

    return this.toView(user);
  }

  /** PATCH /users/:id/activate — reactivate a previously-offboarded user. */
  async activate(actor: AuthUser, id: string) {
    const target = await this.getOrThrow(actor, id);
    const storeId = await this.primaryStoreId(id);
    this.assertCanManage(actor, target.role, storeId);

    const user = await this.prisma.user.update({
      where: { id },
      data: { isActive: true },
      include: USER_INCLUDE,
    });

    await this.audit.record(actor, {
      action: 'user.reactivate',
      entityType: 'User',
      entityId: id,
      storeId,
      summary: `Reactivated ${user.name}`,
      metadata: {},
    });

    return this.toView(user);
  }

  // ── Self-signup approval queue ──────────────────────────────────────────────

  /** Public shape for a pending signup (adds requested role/store to the view). */
  private async toPendingView(user: any) {
    const store = user.requestedStoreId
      ? await this.prisma.store.findUnique({
          where: { id: user.requestedStoreId },
          select: { id: true, name: true },
        })
      : null;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone ?? null,
      requestedRole: (user.requestedRole ?? 'salesperson') as Role,
      requestedStore: store,
      createdAt: user.createdAt,
    };
  }

  /**
   * GET /users/pending — the approval queue. An approver only sees requests they
   * are entitled to act on: requested role strictly BELOW their own rank AND (for
   * scoped managers) requested store inside their scope. head_office sees all.
   */
  async listPending(actor: AuthUser) {
    const pending = await this.prisma.user.findMany({
      where: { organisationId: actor.organisationId, approvalStatus: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
    const visible = pending.filter((u) =>
      canApproveSignup(actor, (u.requestedRole ?? 'salesperson') as Role, u.requestedStoreId),
    );
    return Promise.all(visible.map((u) => this.toPendingView(u)));
  }

  /**
   * POST /users/:id/approve — grant a pending signup. The approver may override
   * the requested role/store; either way the strictly-below-rank + in-scope rules
   * decide what is allowed, so this can never mint a peer/superior or place a user
   * in a store the approver does not own.
   */
  async approve(actor: AuthUser, id: string, dto: ApproveUserDto) {
    const target = await this.getOrThrow(actor, id);
    if (target.approvalStatus !== 'pending') {
      throw new BadRequestException('This account is not awaiting approval');
    }

    const role: Role = dto.role ?? (target.requestedRole as Role) ?? 'salesperson';
    const storeId = dto.storeId ?? target.requestedStoreId ?? null;
    if (!storeId) throw new BadRequestException('A store is required to approve this account');

    // Escalation + scope gate (same guards as manual provisioning).
    this.assertAssignableRole(actor, role);
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      include: { organisation: { select: { slug: true } } },
    });
    if (!store) throw new NotFoundException('Store not found');
    if (store.isAggregate) {
      throw new BadRequestException('Cannot assign a user to the aggregate "All Stores" view');
    }
    this.scope.assertStoreAllowed(actor, storeId);

    // If the approver moved them to a DIFFERENT store than they signed up for,
    // regenerate the login handle so it matches the real store (e.g. a
    // "…mumbaibandra" handle must not survive a reassignment to Udaipur).
    let email: string | undefined;
    if (target.requestedStoreId && storeId !== target.requestedStoreId) {
      email = await uniqueEmailHandle(
        target.name,
        store.name,
        store.organisation?.slug,
        async (candidate) =>
          !!(await this.prisma.user.findFirst({
            where: { email: candidate, id: { not: id } },
            select: { id: true },
          })),
      );
    }

    const user = await this.prisma.user.update({
      where: { id },
      data: {
        role,
        isActive: true,
        approvalStatus: 'approved',
        approvedById: actor.id,
        approvedAt: new Date(),
        ...(email ? { email } : {}),
        userStores: {
          upsert: {
            where: { userId_storeId: { userId: id, storeId } },
            update: { isPrimary: true },
            create: { storeId, isPrimary: true },
          },
        },
      },
      include: USER_INCLUDE,
    });

    await this.audit.record(actor, {
      action: 'user.approve',
      entityType: 'User',
      entityId: id,
      storeId,
      summary: `Approved ${user.name} as ${role}`,
      metadata: { role, storeId },
    });
    return this.toView(user);
  }

  /**
   * POST /users/:id/reject — decline a pending signup. Gated exactly like approve
   * (you can only reject a request you could have approved), so a store manager
   * cannot reject a manager-level request — only head office can.
   */
  async reject(actor: AuthUser, id: string, reason?: string) {
    const target = await this.getOrThrow(actor, id);
    if (target.approvalStatus !== 'pending') {
      throw new BadRequestException('This account is not awaiting approval');
    }
    const role: Role = (target.requestedRole as Role) ?? 'salesperson';
    this.assertAssignableRole(actor, role);
    if (!actor.allStores && target.requestedStoreId) {
      this.scope.assertStoreAllowed(actor, target.requestedStoreId);
    }

    const user = await this.prisma.user.update({
      where: { id },
      data: { approvalStatus: 'rejected', isActive: false },
      include: USER_INCLUDE,
    });
    await this.audit.record(actor, {
      action: 'user.reject',
      entityType: 'User',
      entityId: id,
      storeId: target.requestedStoreId,
      summary: `Rejected signup for ${user.name}`,
      metadata: { reason: reason ?? null },
    });
    return this.toView(user);
  }

  /**
   * PATCH /users/:id/leave-allocation — set a staff member's yearly leave quota
   * (the "holidays allowed" rule) for one leave type. Manager-gated: strictly
   * below the actor's rank and in scope. `used` is preserved.
   */
  async setLeaveAllocation(actor: AuthUser, id: string, dto: SetLeaveAllocationDto) {
    const target = await this.getOrThrow(actor, id);
    const storeId = await this.primaryStoreId(id);
    this.assertCanManage(actor, target.role, storeId);

    const balance = await this.prisma.leaveBalance.upsert({
      where: { userId_type_year: { userId: id, type: dto.type, year: dto.year } },
      update: { allocated: dto.allocated },
      create: { userId: id, storeId, type: dto.type, year: dto.year, allocated: dto.allocated },
    });

    await this.audit.record(actor, {
      action: 'user.leave_allocation',
      entityType: 'User',
      entityId: id,
      storeId,
      summary: `Set ${dto.type} leave for ${target.name}: ${dto.allocated} day(s) in ${dto.year}`,
      metadata: { type: dto.type, year: dto.year, allocated: dto.allocated },
    });
    return {
      userId: id,
      type: balance.type,
      year: balance.year,
      allocated: Number(balance.allocated),
      used: Number(balance.used),
    };
  }

  /**
   * Load a user BY ID, organisation-bounded to the actor. A user in another
   * organisation is indistinguishable from a non-existent one (NotFound), so this
   * is the single org guard every by-id mutation routes through — head_office is
   * "head office of THIS org", never a cross-tenant admin.
   */
  private async getOrThrow(actor: AuthUser, id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, organisationId: actor.organisationId },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}
