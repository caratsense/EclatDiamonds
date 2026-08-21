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
  | { ok: true; userId: string; userName: string; alreadyLinked: boolean }
  | { ok: false; reason: 'invalid_or_expired' | 'phone_taken' };

/**
 * Owns the WhatsApp-number <-> user binding for the internal reporting bot.
 *
 * A number is only trusted after the user proves control of it: they start the
 * link in-app (which shows a one-time code) and send that code to the bot from
 * the number. `resolveActiveUser` is the ONLY way the rest of the bot turns an
 * inbound `from` into a user — the raw number is never trusted on its own.
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
   * coded message arrives (completeLinking).
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
    await this.prisma.whatsAppLinkCode.create({ data: { userId: user.id, codeHash, expiresAt } });

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
   * Called from the inbound path when a message looks like a link code. Finds the
   * matching un-consumed code, binds the sender's number to that code's user, and
   * consumes the code. Idempotent for the same (number, user) pair.
   */
  async completeLinking(fromPhone: string, rawCode: string): Promise<LinkResult> {
    const phoneE164 = this.normalise(fromPhone);
    const code = rawCode.trim().toUpperCase();

    // Candidate codes: unconsumed and unexpired. Small set; bcrypt-compare to find
    // the one that matches (the code itself carries no user id).
    const candidates = await this.prisma.whatsAppLinkCode.findMany({
      where: { consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, name: true, isActive: true } } },
    });

    let matched: (typeof candidates)[number] | null = null;
    for (const c of candidates) {
      if (await bcrypt.compare(code, c.codeHash)) {
        matched = c;
        break;
      }
    }
    if (!matched || !matched.user.isActive) return { ok: false, reason: 'invalid_or_expired' };

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
          phoneE164,
          status: 'active',
          verifiedAt: new Date(),
          lastSeenAt: new Date(),
        },
        update: {
          userId: matched.userId,
          status: 'active',
          verifiedAt: new Date(),
          revokedAt: null,
          lastSeenAt: new Date(),
        },
      }),
    ]);

    if (!alreadyLinked) {
      await this.audit.record(
        { id: matched.userId, name: matched.user.name, email: '', role: 'salesperson', storeIds: [], allStores: false },
        {
          action: 'whatsapp.link',
          entityType: 'WhatsAppIdentity',
          entityId: phoneE164,
          summary: `${matched.user.name} linked WhatsApp ${phoneE164}`,
        },
      );
    }

    return { ok: true, userId: matched.userId, userName: matched.user.name, alreadyLinked };
  }

  /**
   * Resolve an inbound sender to the user who owns that number, if any. Bumps
   * lastSeenAt. Returns null for unknown/revoked numbers — the caller must treat
   * that as "not recognised", never guess.
   */
  async resolveActiveUser(fromPhone: string) {
    const phoneE164 = this.normalise(fromPhone);
    const identity = await this.prisma.whatsAppIdentity.findUnique({
      where: { phoneE164 },
      include: { user: { select: { id: true, name: true, role: true, isActive: true } } },
    });
    if (!identity || identity.status !== 'active' || !identity.user.isActive) return null;

    await this.prisma.whatsAppIdentity.update({
      where: { id: identity.id },
      data: { lastSeenAt: new Date() },
    });
    return identity.user;
  }

  /** Revoke every binding a user holds — called when the user is deactivated. */
  async revokeForUser(userId: string): Promise<number> {
    const res = await this.prisma.whatsAppIdentity.updateMany({
      where: { userId, status: 'active' },
      data: { status: 'revoked', revokedAt: new Date() },
    });
    return res.count;
  }

  /** GET /whatsapp/identities — bound numbers for users inside the actor's scope. */
  async listInScope(actor: AuthUser) {
    const rows = await this.prisma.whatsAppIdentity.findMany({
      where: actor.allStores
        ? {}
        : { user: { userStores: { some: { storeId: { in: actor.storeIds } } } } },
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

  /** POST /whatsapp/identities/:id/revoke — a manager unbinds a number in scope. */
  async revokeById(actor: AuthUser, id: string) {
    const identity = await this.prisma.whatsAppIdentity.findUnique({
      where: { id },
      include: { user: { select: { id: true, name: true, role: true, userStores: { select: { storeId: true } } } } },
    });
    if (!identity) throw new NotFoundException('WhatsApp identity not found');

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
