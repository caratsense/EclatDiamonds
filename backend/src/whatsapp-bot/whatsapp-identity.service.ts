import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { StoreScopeService } from '../common/store-scope.service';
import { AuthUser } from '../common/auth-user';
import { ROLE_RANK } from '../common/role.util';

/** Link-code policy — one place to tune. */
const CODE_TTL_MS = 10 * 60 * 1000; // valid 10 minutes
const CODE_MAX_PER_HOUR = 5; // per user, to stop code spam
/** Unambiguous alphabet — no 0/O, 1/I/L. Copyable AND typable on a phone. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;

/** What an inbound link attempt resolved to (drives the bot's reply). */
export type LinkResult =
  | {
      ok: true;
      userId: string;
      userName: string;
      organisationId: string;
      alreadyLinked: boolean;
    }
  | { ok: false; reason: 'invalid_or_expired' | 'phone_taken' };

/** A resolved bot user — the tenant travels with it so every downstream write is org-scoped. */
export interface ResolvedBotUser {
  id: string;
  name: string;
  role: AuthUser['role'];
  organisationId: string;
}

/**
 * Owns the WhatsApp-number <-> user binding for the internal reporting bot.
 *
 * A number is only trusted after the user proves control of it: they start the
 * link in-app (which shows a one-time code) and send that code to the bot from
 * the number. `resolveActiveUser` is the ONLY way the rest of the bot turns an
 * inbound `from` into a user — the raw number is never trusted on its own.
 *
 * ## Multi-tenancy
 * Every binding carries the user's `organisationId`, stamped at link time. The
 * resolved user hands its organisation to the conversation layer, so the DSR the
 * bot writes, the store it files against, and the head-office users it notifies
 * are all bounded to that one tenant. A linked number can never reach another
 * organisation's stores or reports.
 */
@Injectable()
export class WhatsAppIdentityService {
  private readonly logger = new Logger(WhatsAppIdentityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scope: StoreScopeService,
    private readonly config: ConfigService,
  ) {}

  /** Digits-only E.164 without '+', matching Meta's inbound `from` (India default). */
  private normalise(phone: string): string {
    const digits = (phone ?? '').replace(/\D/g, '');
    if (digits.length === 10) return `91${digits}`;
    if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
    return digits;
  }

  private generateCode(): string {
    let out = '';
    for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    return out;
  }

  /**
   * POST /whatsapp/link/start — the signed-in user asks to link a WhatsApp number.
   * Returns a one-time code to display; the user sends it to the bot from the
   * number they want to bind. We never learn the number here — only when the
   * coded message arrives (completeLinking). The code is stamped with the user's
   * organisation so the resulting binding is tenant-scoped.
   */
  async startLinking(user: AuthUser) {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await this.prisma.whatsAppLinkCode.count({
      where: { userId: user.id, createdAt: { gt: since } },
    });
    if (recent >= CODE_MAX_PER_HOUR) {
      throw new BadRequestException('Too many link attempts — please try again in an hour.');
    }

    const code = this.generateCode();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await this.prisma.whatsAppLinkCode.create({
      data: { userId: user.id, organisationId: user.organisationId, codeHash, expiresAt },
    });

    return {
      code,
      // The number the user should message. Optional — the UI can also just name
      // "the Eclat bot" when this is unset (e.g. before the prod number exists).
      botNumber: this.config.get<string>('WHATSAPP_BOT_NUMBER') ?? null,
      expiresAt: expiresAt.toISOString(),
      expiresInMinutes: CODE_TTL_MS / 60000,
    };
  }

  /**
   * A manager issues a code FOR SOMEBODY ELSE.
   *
   * `startLinking` above binds the caller's own handset, which is the right
   * shape for a developer and the wrong one for a shop. The people who file
   * daily reports are store managers; asking each of them to sign in to the
   * dashboard, find a settings page and copy a code out of it is how a feature
   * ends up used by nobody. In practice one person sets the branches up, reads
   * the codes out, and the managers send them from the handsets they already
   * have in their hands.
   *
   * So this is the same act with a different subject, and the rules that matter
   * are unchanged:
   *
   *  - The code still only proves WHO; the number is learnt when the coded
   *    message arrives, from the message itself. Nobody types a phone number
   *    here, so nobody can bind a number they do not control.
   *  - Store scope is asserted against the target, not the caller, so a manager
   *    cannot onboard somebody at a branch they do not run.
   *  - The hourly ceiling counts codes per TARGET. Issuing on behalf must not
   *    become a way around the limit that protects the person being onboarded.
   */
  async startLinkingFor(actor: AuthUser, targetUserId: string) {
    const target = await this.prisma.user.findFirst({
      where: { id: targetUserId, organisationId: actor.organisationId },
      select: {
        id: true,
        name: true,
        role: true,
        isActive: true,
        organisationId: true,
        userStores: { select: { storeId: true } },
      },
    });
    // Same message for "no such user" and "another tenant's user": a different
    // one would turn this into a way to test whether an id exists.
    if (!target) throw new NotFoundException('No such team member.');
    if (!target.isActive) {
      throw new BadRequestException(
        `${target.name} is deactivated. Reactivate them before linking a number.`,
      );
    }

    /*
     * The caller must run at least one of the target's branches. Head office
     * passes `allStores` and reaches everybody; a store manager reaches their
     * own team and no further.
     */
    if (!actor.allStores) {
      const theirs = new Set(actor.storeIds);
      const overlap = target.userStores.some((s) => theirs.has(s.storeId));
      if (!overlap) {
        throw new ForbiddenException(
          `${target.name} is not at a branch you manage.`,
        );
      }
    }

    const issued = await this.startLinking({
      id: target.id,
      name: target.name,
      role: target.role,
      organisationId: target.organisationId,
      storeIds: target.userStores.map((s) => s.storeId),
      allStores: false,
    } as AuthUser);

    /*
     * Who issued it, for whom.
     *
     * `completeLinking` already audits the binding, but it records the TARGET
     * as the actor -- correct when somebody links their own handset, and a gap
     * the moment an admin does it on their behalf. Without this line the trail
     * says "Aarav linked a number" and nothing anywhere says head office
     * started it. The code grants access to a reporting bot; who handed it out
     * is the part worth being able to ask about later.
     *
     * Recorded at ISSUE rather than at completion, because a code that is
     * never redeemed still happened and is still worth seeing.
     */
    await this.audit.record(actor, {
      action: 'whatsapp.link_code_issued',
      entityType: 'User',
      entityId: target.id,
      summary: `${actor.name ?? 'A manager'} issued a WhatsApp link code for ${target.name}`,
      metadata: { targetRole: target.role, expiresAt: issued.expiresAt },
    });

    return issued;
  }

  /**
   * Called from the inbound path when a message looks like a link code. Finds the
   * matching un-consumed code, binds the sender's number to that code's user, and
   * consumes the code. Idempotent for the same (number, user) pair. The binding
   * inherits the code owner's organisation.
   */
  async completeLinking(fromPhone: string, rawCode: string): Promise<LinkResult> {
    const phoneE164 = this.normalise(fromPhone);
    const code = rawCode.trim().toUpperCase();

    // Candidate codes: unconsumed and unexpired. Small set; bcrypt-compare to find
    // the one that matches (the code itself carries no user id).
    const candidates = await this.prisma.whatsAppLinkCode.findMany({
      where: { consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, name: true, isActive: true, organisationId: true } } },
    });

    let matched: (typeof candidates)[number] | null = null;
    for (const c of candidates) {
      if (await bcrypt.compare(code, c.codeHash)) {
        matched = c;
        break;
      }
    }
    if (!matched || !matched.user.isActive) return { ok: false, reason: 'invalid_or_expired' };

    const orgId = matched.user.organisationId;

    // Guard against binding a number already owned by someone else.
    const existing = await this.prisma.whatsAppIdentity.findUnique({ where: { phoneE164 } });
    if (existing && existing.status === 'active' && existing.userId !== matched.userId) {
      return { ok: false, reason: 'phone_taken' };
    }

    const alreadyLinked = !!existing && existing.userId === matched.userId && existing.status === 'active';

    await this.prisma.$transaction([
      this.prisma.whatsAppLinkCode.update({
        where: { id: matched.id },
        data: { consumedAt: new Date() },
      }),
      this.prisma.whatsAppIdentity.upsert({
        where: { phoneE164 },
        create: {
          userId: matched.userId,
          organisationId: orgId,
          phoneE164,
          status: 'active',
          verifiedAt: new Date(),
          lastSeenAt: new Date(),
        },
        update: {
          userId: matched.userId,
          organisationId: orgId,
          status: 'active',
          verifiedAt: new Date(),
          revokedAt: null,
          lastSeenAt: new Date(),
        },
      }),
    ]);

    if (!alreadyLinked) {
      await this.audit.record(
        {
          id: matched.userId,
          name: matched.user.name,
          email: '',
          role: 'salesperson',
          organisationId: orgId ?? '',
          storeIds: [],
          allStores: false,
        },
        {
          action: 'whatsapp.link',
          entityType: 'WhatsAppIdentity',
          entityId: phoneE164,
          summary: `${matched.user.name} linked WhatsApp ${phoneE164}`,
        },
      );
    }

    return { ok: true, userId: matched.userId, userName: matched.user.name, organisationId: orgId, alreadyLinked };
  }

  /**
   * Resolve an inbound sender to the user who owns that number, if any. Bumps
   * lastSeenAt. Returns null for unknown/revoked numbers — the caller must treat
   * that as "not recognised", never guess. The user's `organisationId` rides
   * along so the conversation can build an org-scoped principal.
   */
  async resolveActiveUser(fromPhone: string): Promise<ResolvedBotUser | null> {
    const phoneE164 = this.normalise(fromPhone);
    const identity = await this.prisma.whatsAppIdentity.findUnique({
      where: { phoneE164 },
      include: {
        user: { select: { id: true, name: true, role: true, isActive: true, organisationId: true } },
      },
    });
    if (!identity || identity.status !== 'active' || !identity.user.isActive) return null;

    await this.prisma.whatsAppIdentity.update({
      where: { id: identity.id },
      data: { lastSeenAt: new Date() },
    });
    const u = identity.user;
    return { id: u.id, name: u.name, role: u.role, organisationId: u.organisationId };
  }

  /** Revoke every binding a user holds — called when the user is deactivated. */
  async revokeForUser(userId: string): Promise<number> {
    const res = await this.prisma.whatsAppIdentity.updateMany({
      where: { userId, status: 'active' },
      data: { status: 'revoked', revokedAt: new Date() },
    });
    return res.count;
  }

  /**
   * GET /whatsapp/identities — bound numbers for users inside the actor's scope.
   * Bounded to the actor's OWN organisation first (a head-office user with
   * allStores must never see another tenant's bindings), then narrowed by store
   * scope for lower roles.
   */
  async listInScope(actor: AuthUser) {
    const rows = await this.prisma.whatsAppIdentity.findMany({
      where: {
        organisationId: actor.organisationId,
        ...(actor.allStores
          ? {}
          : { user: { userStores: { some: { storeId: { in: actor.storeIds } } } } }),
      },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, name: true, role: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      phoneE164: r.phoneE164,
      status: r.status,
      user: r.user,
      verifiedAt: r.verifiedAt?.toISOString() ?? null,
      lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
    }));
  }

  /**
   * Everybody in scope, linked or not.
   *
   * `listInScope` answers "which numbers are bound", which is the wrong
   * question for the screen that onboards people: the rows that matter there
   * are the ones that are MISSING. A manager who has never linked a handset
   * does not appear in a list of handsets, so an admin reading it cannot tell
   * a complete rollout from one nobody has started.
   *
   * Salespeople are included deliberately. The daily report is a manager's job
   * today, but an admin deciding who gets the bot should be choosing from the
   * whole team rather than from a list somebody else pre-filtered.
   */
  async rosterInScope(actor: AuthUser) {
    const people = await this.prisma.user.findMany({
      where: {
        organisationId: actor.organisationId,
        isActive: true,
        approvalStatus: 'approved',
        // Head office reaches everybody; anyone else reaches their own branches.
        ...(actor.allStores
          ? {}
          : { userStores: { some: { storeId: { in: actor.storeIds } } } }),
      },
      orderBy: [{ name: 'asc' }],
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        userStores: { select: { store: { select: { id: true, name: true } } } },
        whatsappIdentities: {
          select: {
            id: true,
            phoneE164: true,
            status: true,
            verifiedAt: true,
            lastSeenAt: true,
          },
        },
      },
    });

    return people.map((u) => {
      // A revoked binding is history, not access. Only an active one counts.
      const active = u.whatsappIdentities.find((i) => i.status === 'active') ?? null;
      /*
       * Only the branches the CALLER can see.
       *
       * The filter above returns people who work at one of the caller's
       * branches, but a colleague posted to several carries all of them in
       * this list -- so a Surat manager was reading "Mumbai - Bandra" off a
       * head-office row. Harmless on its own, and still somebody else's
       * organisation chart leaking through a screen about phone numbers.
       */
      const visibleStores = actor.allStores
        ? u.userStores.map((s) => s.store)
        : u.userStores
            .filter((s) => actor.storeIds.includes(s.store.id))
            .map((s) => s.store);

      return {
        userId: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        stores: visibleStores,
        identity: active
          ? {
              id: active.id,
              // Last four only. Enough to recognise their handset, useless to
              // anybody reading over a shoulder.
              phoneSuffix: `…${active.phoneE164.slice(-4)}`,
              verifiedAt: active.verifiedAt?.toISOString() ?? null,
              lastSeenAt: active.lastSeenAt?.toISOString() ?? null,
            }
          : null,
      };
    });
  }

  /** POST /whatsapp/identities/:id/revoke — a manager unbinds a number in scope. */
  async revokeById(actor: AuthUser, id: string) {
    const identity = await this.prisma.whatsAppIdentity.findUnique({
      where: { id },
      include: {
        user: {
          select: { id: true, name: true, role: true, userStores: { select: { storeId: true } } },
        },
      },
    });
    if (!identity) throw new NotFoundException('WhatsApp identity not found');

    // Tenant boundary first: a manager may only touch bindings in their own org.
    this.scope.assertOrgAllowed(actor, identity.organisationId);

    if (!actor.allStores) {
      const overlap = identity.user.userStores.some((us) => actor.storeIds.includes(us.storeId));
      if (!overlap) throw new ForbiddenException('That user is not in your store scope');
      if (ROLE_RANK[identity.user.role] > ROLE_RANK[actor.role]) {
        throw new ForbiddenException('You cannot manage a user above your own role');
      }
    }
    if (identity.status !== 'active') {
      throw new ConflictException('This number is already revoked');
    }

    await this.prisma.whatsAppIdentity.update({
      where: { id },
      data: { status: 'revoked', revokedAt: new Date() },
    });
    await this.audit.record(actor, {
      action: 'whatsapp.revoke',
      entityType: 'WhatsAppIdentity',
      entityId: identity.phoneE164,
      summary: `Revoked WhatsApp ${identity.phoneE164} for ${identity.user.name}`,
    });
    return { ok: true };
  }
}
