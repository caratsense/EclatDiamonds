import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccessOverride, HEAD_OFFICE_ONLY, MODULES, ROLE_ACCESS, effectiveAccess } from '../auth/access';
import { Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { StoreScopeService } from '../common/store-scope.service';
import { ROLE_LABELS, ROLE_RANK } from '../common/role.util';
import { updateOrgSettings } from '../config/org-settings';
import { EmailService } from '../integrations/email.service';
import { WhatsAppIdentityService } from '../whatsapp-bot/whatsapp-identity.service';
import {
  LOGIN_ID_TOKENS,
  SIGNUP_POLICY_KEY,
  allocateLoginId,
  canApproveSignup,
  loginIdTemplateError,
  loginIdUsesStore,
  readSignupPolicy,
  renderLoginId,
  requestableRoles,
  withSavepoint,
  type SignupPolicy,
} from './users.util';
import {
  ApproveUserDto,
  CreateUserDto,
  DeactivateUserDto,
  SetLeaveAllocationDto,
  UpdateSignupPolicyDto,
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
    private readonly email: EmailService,
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
      include: { organisation: { select: { slug: true, settings: true } } },
    });
    if (!store) throw new NotFoundException('Store not found');
    if (store.isAggregate) {
      throw new BadRequestException('Cannot assign a user to the aggregate "All Stores" view');
    }
    if (store.isHolding) {
      throw new BadRequestException('Cannot assign a user to the unassigned import bucket');
    }

    // Login ID: generated and unique, by the same renderer self-signup uses, so
    // every account however created follows this tenant's template (or the
    // default `firstname.storeslug@<tenant domain>`). The person signs in with a
    // phone OTP or, after a manager sets one, this + a password.
    const policy = readSignupPolicy(store.organisation.settings);
    const subject = { name: dto.name, storeName: store.name, organisationSlug: store.organisation.slug };

    // Random password — the user logs in via OTP, or a manager resets it to share one.
    const passwordHash = await bcrypt.hash(randomBytes(24).toString('hex'), 10);

    const user = await allocateLoginId(
      (n) => renderLoginId(policy.loginIdTemplate, subject, n),
      (email) =>
        this.prisma.user.create({
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
        }),
    );

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
    if (store.isHolding) {
      throw new BadRequestException('Cannot assign a user to the unassigned import bucket');
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
    const [store, priorRejection] = await Promise.all([
      user.requestedStoreId
        ? this.prisma.store.findUnique({
            where: { id: user.requestedStoreId },
            select: { id: true, name: true, status: true, isActive: true },
          })
        : null,
      // Reapplication context (users.util REAPPLICATION POLICY): the latest
      // earlier decline for this phone in this organisation, if any.
      user.phone
        ? this.prisma.user.findFirst({
            where: {
              organisationId: user.organisationId,
              phone: user.phone,
              approvalStatus: 'rejected',
              id: { not: user.id },
            },
            orderBy: { rejectedAt: { sort: 'desc', nulls: 'last' } },
            select: { rejectedAt: true, rejectionReason: true },
          })
        : null,
    ]);
    return {
      id: user.id,
      name: user.name,
      /** The Login ID reserved for them. An identifier, not a mailbox. */
      loginId: user.email,
      email: user.email,
      contactEmail: user.contactEmail ?? null,
      phone: user.phone ?? null,
      requestedRole: (user.requestedRole ?? 'salesperson') as Role,
      requestedStore: store
        ? { id: store.id, name: store.name, isOpen: store.status !== 'closed' && store.isActive }
        : null,
      createdAt: user.createdAt,
      priorRejection: priorRejection
        ? { at: priorRejection.rejectedAt, reason: priorRejection.rejectionReason }
        : null,
    };
  }

  /**
   * GET /users/pending — the approval queue. An approver only sees requests they
   * are entitled to act on (canApproveSignup): a store manager sees salesperson
   * and storeperson requests for their own stores; head office sees the rest.
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
   * The approver as the database knows them NOW — role re-read, store scope
   * re-resolved — not as their token or the page they loaded remembers them. A
   * manager demoted, deactivated or taken off a branch between opening the queue
   * and pressing Approve is judged on what they are at the moment of decision.
   */
  private async currentApprover(tx: Prisma.TransactionClient, actor: AuthUser): Promise<AuthUser> {
    const row = actor.isMachine
      ? null
      : await tx.user.findFirst({
          where: {
            id: actor.id,
            organisationId: actor.organisationId,
            isActive: true,
            approvalStatus: 'approved',
          },
          select: { role: true },
        });
    if (!row) throw new ForbiddenException('Your access has changed. Reload and try again.');
    const { storeIds, allStores } = await this.scope.resolveScope(
      actor.id,
      row.role,
      actor.organisationId,
    );
    return { ...actor, role: row.role, storeIds, allStores };
  }

  /**
   * POST /users/:id/approve — grant a pending signup, as ONE transaction:
   *
   *  1. re-read the approver's current role and scope (currentApprover);
   *  2. the approver must be entitled to the REQUEST as made — a store manager
   *     cannot take a manager-level or another store's request by approving it
   *     as something smaller — and to what is actually GRANTED after any
   *     role/store override;
   *  3. the store must still be open;
   *  4. a conditional update claims the row only while it is still pending, so a
   *     replayed or concurrent approval (or a racing rejection) changes nothing
   *     and gets 409 — never a second store binding;
   *  5. store binding, a re-issued Login ID when the store (part of the ID)
   *     changed, the audit row and the applicant's notification commit with it.
   *
   * The optional email to the applicant's contact address is sent after commit
   * and reported as it actually went: sent, dry_run, failed or no_contact_email.
   */
  async approve(actor: AuthUser, id: string, dto: ApproveUserDto) {
    const decided = await this.prisma.$transaction(async (tx) => {
      const approver = await this.currentApprover(tx, actor);
      const target = await tx.user.findFirst({
        where: { id, organisationId: actor.organisationId },
        include: { organisation: { select: { slug: true, settings: true } } },
      });
      if (!target) throw new NotFoundException('User not found');
      if (target.approvalStatus !== 'pending') {
        throw new ConflictException('This request has already been decided');
      }

      const requestedRole = (target.requestedRole ?? 'salesperson') as Role;
      if (!canApproveSignup(approver, requestedRole, target.requestedStoreId)) {
        throw new ForbiddenException('You cannot decide this request');
      }
      const role: Role = dto.role ?? requestedRole;
      const storeId = dto.storeId ?? target.requestedStoreId;
      if (!storeId) throw new BadRequestException('A store is required to approve this account');
      // Scope before lookup, so another tenant's store id is refused exactly like
      // any store outside the approver's reach.
      if (!canApproveSignup(approver, role, storeId)) {
        throw new ForbiddenException('You can only grant roles below your own, in your own stores');
      }
      const store = await tx.store.findFirst({
        where: {
          id: storeId,
          organisationId: actor.organisationId,
          isAggregate: false,
          isHolding: false,
        },
      });
      if (!store) throw new BadRequestException('Choose a valid store');
      if (store.status === 'closed' || !store.isActive) {
        throw new ConflictException(
          `${store.name} is not open. Activate it, or approve into another store.`,
        );
      }

      const claimed = await tx.user.updateMany({
        where: { id, organisationId: actor.organisationId, approvalStatus: 'pending' },
        data: {
          role,
          isActive: true,
          approvalStatus: 'approved',
          approvedById: approver.id,
          approvedAt: new Date(),
        },
      });
      if (claimed.count !== 1) throw new ConflictException('This request has already been decided');

      // A pending row has no store link by construction; create, never upsert,
      // so a second binding is an error rather than a silent merge.
      await tx.userStore.create({ data: { userId: id, storeId, isPrimary: true } });

      // Moved to a DIFFERENT store than requested: when the store is part of the
      // ID, re-issue it (a "…andheri" ID must not survive a move to Bandra).
      const policy = readSignupPolicy(target.organisation.settings);
      let loginId = target.email;
      if (
        target.requestedStoreId &&
        storeId !== target.requestedStoreId &&
        loginIdUsesStore(policy.loginIdTemplate)
      ) {
        const subject = {
          name: target.name,
          storeName: store.name,
          organisationSlug: target.organisation.slug,
        };
        loginId = await allocateLoginId(
          (n) => renderLoginId(policy.loginIdTemplate, subject, n),
          async (email) => {
            await withSavepoint(tx, () => tx.user.update({ where: { id }, data: { email } }));
            return email;
          },
        );
      }

      await this.audit.record(
        approver,
        {
          action: 'user.approve',
          entityType: 'User',
          entityId: id,
          storeId,
          summary: `Approved ${target.name} as ${role}`,
          metadata: {
            role,
            storeId,
            requestedRole,
            requestedStoreId: target.requestedStoreId,
            loginId,
          },
        },
        tx,
      );
      await tx.notification.create({
        data: {
          userId: id,
          kind: 'system',
          title: 'Your account is approved',
          body: `Welcome to ${store.name}. Your Login ID is ${loginId}.`,
          storeId,
          entityType: 'User',
          entityId: id,
          actorId: approver.id,
          actorName: approver.name,
          dedupeKey: 'signup-approved',
        },
      });
      return { loginId, contactEmail: target.contactEmail, name: target.name, role, storeName: store.name };
    });

    const contactEmailDelivery = await this.sendApprovalEmail(decided);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id }, include: USER_INCLUDE });
    return { ...this.toView(user), loginId: decided.loginId, contactEmailDelivery };
  }

  /** Tell the applicant, at the contact address they gave, that they can sign in. */
  private async sendApprovalEmail(d: {
    loginId: string;
    contactEmail: string | null;
    name: string;
    role: Role;
    storeName: string;
  }): Promise<'sent' | 'dry_run' | 'failed' | 'no_contact_email'> {
    if (!d.contactEmail) return 'no_contact_email';
    const result = await this.email.send(
      d.contactEmail,
      'Your account is approved',
      [
        `Hello ${d.name},`,
        '',
        `Your account has been approved as ${ROLE_LABELS[d.role]} at ${d.storeName}.`,
        '',
        `Login ID: ${d.loginId}`,
        'This is your sign-in ID, not an email inbox. Nothing is delivered to it.',
        'Sign in with it and the password you chose when you signed up.',
      ].join('\n'),
    );
    return result.sent ? 'sent' : result.dryRun ? 'dry_run' : 'failed';
  }

  /**
   * POST /users/:id/reject — decline a pending signup, with a reason. Gated
   * exactly like approve (you can only reject a request you could have
   * approved) and claimed the same conditional way, so it cannot overwrite an
   * approval that landed first. Terminal for this request; see the
   * reapplication policy in users.util.
   */
  async reject(actor: AuthUser, id: string, reason?: string) {
    const rejectionReason = reason?.trim() || null;
    await this.prisma.$transaction(async (tx) => {
      const approver = await this.currentApprover(tx, actor);
      const target = await tx.user.findFirst({ where: { id, organisationId: actor.organisationId } });
      if (!target) throw new NotFoundException('User not found');
      if (target.approvalStatus !== 'pending') {
        throw new ConflictException('This request has already been decided');
      }
      const requestedRole = (target.requestedRole ?? 'salesperson') as Role;
      if (!canApproveSignup(approver, requestedRole, target.requestedStoreId)) {
        throw new ForbiddenException('You cannot decide this request');
      }
      const claimed = await tx.user.updateMany({
        where: { id, organisationId: actor.organisationId, approvalStatus: 'pending' },
        data: {
          approvalStatus: 'rejected',
          isActive: false,
          rejectedById: approver.id,
          rejectedAt: new Date(),
          rejectionReason,
        },
      });
      if (claimed.count !== 1) throw new ConflictException('This request has already been decided');
      await this.audit.record(
        approver,
        {
          action: 'user.reject',
          entityType: 'User',
          entityId: id,
          storeId: target.requestedStoreId,
          summary: `Rejected signup for ${target.name}`,
          metadata: { reason: rejectionReason, requestedRole },
        },
        tx,
      );
    });
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id }, include: USER_INCLUDE });
    return this.toView(user);
  }

  // ── Signup policy (head office) ─────────────────────────────────────────────

  /** GET /users/signup-policy — the tenant's Login ID template and manager self-request switch. */
  async signupPolicy(actor: AuthUser) {
    const org = await this.prisma.organisation.findUniqueOrThrow({
      where: { id: actor.organisationId },
      select: { slug: true, settings: true },
    });
    const policy = readSignupPolicy(org.settings);
    const sample = { name: 'Priya Sharma', storeName: 'Main Store', organisationSlug: org.slug };
    return {
      ...policy,
      organisationCode: org.slug,
      tokens: LOGIN_ID_TOKENS.map((t) => `{${t}}`),
      requestableRoles: requestableRoles(policy),
      example: renderLoginId(policy.loginIdTemplate, sample, 1),
      defaultExample: renderLoginId(null, sample, 1),
    };
  }

  /**
   * PUT /users/signup-policy — head office only (route-gated). Applies to users
   * created from now on; a stored Login ID is never rewritten by a template change.
   */
  async saveSignupPolicy(actor: AuthUser, dto: UpdateSignupPolicyDto) {
    const org = await this.prisma.organisation.findUniqueOrThrow({
      where: { id: actor.organisationId },
      select: { slug: true },
    });
    // Only fields that were sent; a validated DTO carries the others as undefined.
    const sent: Partial<SignupPolicy> = {};
    if (dto.allowManagerSelfRequest !== undefined) {
      sent.allowManagerSelfRequest = dto.allowManagerSelfRequest;
    }
    if (dto.loginIdTemplate !== undefined) {
      const template = dto.loginIdTemplate?.trim().toLowerCase() || null;
      const error = template ? loginIdTemplateError(template, org.slug) : null;
      if (error) throw new BadRequestException(error);
      sent.loginIdTemplate = template;
    }
    let next = readSignupPolicy(null);
    await updateOrgSettings(this.prisma, actor.organisationId, (settings) => {
      next = { ...readSignupPolicy(settings), ...sent };
      return { ...settings, [SIGNUP_POLICY_KEY]: next };
    });
    await this.audit.record(actor, {
      action: 'organisation.signup_policy_changed',
      entityType: 'Organisation',
      entityId: actor.organisationId,
      summary: `Signup policy: Login ID template ${next.loginIdTemplate ?? 'default'}, manager self-request ${
        next.allowManagerSelfRequest ? 'on' : 'off'
      }`,
      metadata: { ...next },
    });
    return this.signupPolicy(actor);
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
    // A pending or declined signup is decided through approve/reject only.
    // Activating, re-roling or store-linking it here would hand a request
    // access that no approver granted.
    if (user.approvalStatus !== 'approved') {
      throw new ConflictException(
        'This account is an account request. Approve or reject it instead.',
      );
    }
    return user;
  }

  // ===========================================================================
  // Per-person access (auth/access.ts)
  // ===========================================================================

  /** GET /users/:id/access — role defaults, head office's changes, and the result. */
  async access(actor: AuthUser, id: string) {
    const u = await this.prisma.user.findFirst({
      where: { id, organisationId: actor.organisationId },
      select: { id: true, name: true, role: true, accessOverrides: true },
    });
    if (!u) throw new NotFoundException('User not found');
    return {
      userId: u.id,
      name: u.name,
      role: u.role,
      defaults: ROLE_ACCESS[u.role],
      overrides: (u.accessOverrides ?? {}) as Record<string, AccessOverride>,
      effective: effectiveAccess(u.role, u.accessOverrides),
    };
  }

  /** PUT /users/:id/access — replace head office's changes for one person. */
  async setAccess(actor: AuthUser, id: string, overrides: Record<string, string>) {
    const u = await this.prisma.user.findFirst({
      where: { id, organisationId: actor.organisationId },
      select: { id: true, name: true, role: true, accessOverrides: true },
    });
    if (!u) throw new NotFoundException('User not found');
    if (u.role === 'head_office') {
      throw new BadRequestException('Head office always has every screen.');
    }
    const defaults = ROLE_ACCESS[u.role];
    const clean: Record<string, AccessOverride> = {};
    for (const [slug, level] of Object.entries(overrides ?? {})) {
      if (!(MODULES as readonly string[]).includes(slug)) {
        throw new BadRequestException(`Unknown screen: ${slug}`);
      }
      if (level !== 'none' && level !== 'own' && level !== 'store') {
        throw new BadRequestException(`${slug}: choose none, own or store`);
      }
      if (level !== 'none' && (HEAD_OFFICE_ONLY as string[]).includes(slug)) {
        throw new BadRequestException(`${slug} is for head office only`);
      }
      // Equal to the role's default: not a change, so not stored.
      if ((defaults[slug] ?? 'none') === level) continue;
      clean[slug] = level;
    }
    const before = (u.accessOverrides ?? {}) as Record<string, AccessOverride>;
    await this.prisma.user.update({
      where: { id: u.id },
      data: { accessOverrides: Object.keys(clean).length ? clean : Prisma.DbNull },
    });
    await this.audit.record(actor, {
      action: 'user.access_update',
      entityType: 'User',
      entityId: u.id,
      storeId: null,
      summary: `Changed what ${u.name} can open`,
      metadata: { before, after: clean },
    });
    return this.access(actor, id);
  }
}
