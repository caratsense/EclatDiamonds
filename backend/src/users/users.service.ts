import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { StoreScopeService } from '../common/store-scope.service';
import { ROLE_RANK } from '../common/role.util';
import {
  CreateUserDto,
  DeactivateUserDto,
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
    let where: any = {};
    let visibleStoreIds: string[] | undefined;
    if (!actor.allStores || (requestedStoreId && requestedStoreId !== 'all')) {
      const ids = this.scope.effectiveStoreIds(actor, requestedStoreId);
      where = { userStores: { some: { storeId: { in: ids } } } };
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
  async listUnassigned(_actor: AuthUser) {
    const users = await this.prisma.user.findMany({
      where: { isActive: true, userStores: { none: {} } },
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
    const rawEmail = dto.email?.trim().toLowerCase() || null;

    if (!phone && !rawEmail) {
      throw new BadRequestException('Provide a phone number and/or an email so the user can sign in');
    }
    if (phone && !last10(phone)) {
      throw new BadRequestException('Enter a valid 10-digit mobile number');
    }

    const store = await this.prisma.store.findUnique({ where: { id: dto.storeId } });
    if (!store) throw new NotFoundException('Store not found');
    if (store.isAggregate) {
      throw new BadRequestException('Cannot assign a user to the aggregate "All Stores" view');
    }

    // Email is a required unique column. When only a phone is given, synthesize a
    // stable placeholder so OTP-by-phone remains the real login identifier.
    const email = rawEmail ?? `${last10(phone!)}@staff.local`;

    const clash = await this.prisma.user.findUnique({ where: { email } });
    if (clash) throw new ConflictException(`A user with email "${email}" already exists`);

    // Random password — the user logs in via OTP, never with this.
    const passwordHash = await bcrypt.hash(randomBytes(24).toString('hex'), 10);

    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        email,
        phone,
        initials: initialsOf(dto.name),
        role,
        passwordHash,
        isActive: true,
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
    const existing = await this.getOrThrow(id);
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
    const existing = await this.getOrThrow(id);
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
    const target = await this.getOrThrow(id);
    const storeId = await this.primaryStoreId(id);
    this.assertCanManage(actor, target.role, storeId);

    const reassignToId = dto.reassignToId?.trim() || null;
    let reassigned: { leads: number; checkIns: number } | null = null;

    if (reassignToId) {
      if (reassignToId === id) {
        throw new BadRequestException('Cannot hand off work to the user being deactivated');
      }
      const recipient = await this.getOrThrow(reassignToId);
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
      data: { isActive: false },
      include: USER_INCLUDE,
    });

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
    const target = await this.getOrThrow(id);
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

  private async getOrThrow(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}
