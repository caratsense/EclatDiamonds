import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { randomInt } from 'crypto';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { ROLE_RANK } from '../common/role.util';
import { WhatsAppService } from '../integrations/whatsapp.service';
import { SignupDto } from './dto/signup.dto';
import { uniqueEmailHandle } from '../users/users.util';
import { LoginLockout } from './login-lockout';

/** OTP policy — one place to tune. */
const OTP_TTL_MS = 5 * 60 * 1000; // code valid 5 minutes
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // min gap between requests per phone
const OTP_MAX_PER_HOUR = 5; // max requests per phone per hour
const OTP_MAX_ATTEMPTS = 3; // wrong-code tries before the code is dead

/** Google's only valid `iss` values for an ID token. */
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/** Public shape of a store as the frontend expects it. */
function storeView(s: { id: string; name: string; city: string; isAggregate: boolean }) {
  return { id: s.id, name: s.name, city: s.city, isAggregate: s.isAggregate || undefined };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /** Lazily-built Google verifier — caches Google's JWKS across requests. */
  private googleClient?: OAuth2Client;

  /** Per-handle failed-login freeze — see LoginLockout. */
  private readonly lockout = new LoginLockout();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly scope: StoreScopeService,
    private readonly config: ConfigService,
    private readonly whatsapp: WhatsAppService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Verify the ID token locally against Google's JWKS (the library caches the keys
   * and handles rotation), so login doesn't depend on a call out to Google.
   * Checks signature/aud/exp; `iss` we assert ourselves.
   */
  private async verifyGoogleToken(credential: string, clientId: string): Promise<TokenPayload> {
    if (!this.googleClient) this.googleClient = new OAuth2Client(clientId);

    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken: credential,
        audience: clientId,
      });
      payload = ticket.getPayload();
    } catch (err) {
      this.logger.warn(`Google ID-token verification failed: ${(err as Error)?.message ?? err}`);
      throw new UnauthorizedException('Could not verify Google sign-in');
    }

    if (!payload) throw new UnauthorizedException('Could not verify Google sign-in');
    if (!GOOGLE_ISSUERS.includes(payload.iss)) {
      throw new UnauthorizedException('Invalid Google sign-in');
    }
    return payload;
  }

  /**
   * Restrict sign-in to Workspace domains, e.g. GOOGLE_ALLOWED_DOMAINS="caratsense.in".
   * Skipped while empty — personal Gmail tokens have no `hd` claim, so this only
   * becomes useful once the OAuth client lives in a Workspace project.
   */
  private assertAllowedDomain(payload: TokenPayload) {
    const raw = this.config.get<string>('GOOGLE_ALLOWED_DOMAINS')?.trim();
    if (!raw) return;

    const allowed = raw
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    if (!allowed.length) return;

    const hd = String(payload.hd ?? '').toLowerCase();
    if (!hd || !allowed.includes(hd)) {
      throw new UnauthorizedException('This Google account is not permitted to sign in');
    }
  }

  /**
   * POST /auth/google — sign in with a Google ID token.
   *
   * Matches on Google's `sub`, not the email: emails get recycled to new hires and
   * we'd otherwise hand them the previous owner's role and store scope. Email is
   * only used once, to link an already-provisioned account on first sign-in.
   *
   * Never creates users and never touches role/UserStore — that stays in
   * UsersService. Returns 400 until GOOGLE_CLIENT_ID is set.
   */
  async loginWithGoogle(credential: string, nonce?: string) {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID');
    if (!clientId) throw new BadRequestException('Google sign-in is not configured');

    const payload = await this.verifyGoogleToken(credential, clientId);

    // Replay guard. Optional so an older frontend build still works.
    if (nonce && payload.nonce !== nonce) {
      throw new UnauthorizedException('Invalid Google sign-in');
    }

    if (payload.email_verified !== true) {
      throw new UnauthorizedException('Invalid Google sign-in');
    }
    this.assertAllowedDomain(payload);

    const sub = payload.sub;
    const email = String(payload.email ?? '').toLowerCase();
    if (!sub || !email) throw new UnauthorizedException('Invalid Google sign-in');

    // One message for every failure below, so we don't leak which emails exist.
    const rejected = new UnauthorizedException(
      'No CaratSense account for this Google email — ask an admin to add you.',
    );

    let user = await this.prisma.user.findUnique({ where: { googleSub: sub } });
    let linked = false;

    if (!user) {
      // First sign-in — link this account to the sub.
      const byEmail = await this.prisma.user.findUnique({ where: { email } });
      if (!byEmail || !byEmail.isActive) throw rejected;

      if (byEmail.googleSub && byEmail.googleSub !== sub) {
        // Address was recycled or is being impersonated — needs a manager to sort out.
        this.logger.warn(`Google sub mismatch for ${email}`);
        throw rejected;
      }

      user = await this.prisma.user.update({
        where: { id: byEmail.id },
        data: { googleSub: sub },
      });
      linked = true;
    }

    if (!user.isActive) throw rejected;

    const token = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    });
    const session = await this.buildSession(user.id, user.role);

    const actor: AuthUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      storeIds: session.stores.filter((s) => !s.isAggregate).map((s) => s.id),
      allStores: user.role === 'head_office',
    };
    if (linked) {
      await this.audit.record(actor, {
        action: 'user.google_link',
        entityType: 'User',
        entityId: user.id,
        summary: `Linked Google account to ${user.email}`,
        metadata: { email },
      });
    }
    await this.audit.record(actor, {
      action: 'user.google_login',
      entityType: 'User',
      entityId: user.id,
      summary: `${user.name} signed in with Google`,
    });

    return { token, ...session };
  }

  /**
   * POST /auth/signup — self-registration. Creates a POWERLESS pending request,
   * never an account with access: `isActive=false`, `approvalStatus=pending`,
   * real `role=salesperson`, no store link. The requested role/store are recorded
   * for the approver and only granted when an authorised approver acts. So opening
   * signup to the public never widens privilege — the invite-only security posture
   * is preserved; a pending row can do nothing until approved.
   */
  async signup(dto: SignupDto) {
    const contactEmail = dto.email?.trim().toLowerCase() || null;
    const phone = dto.phone?.trim() || null;

    const store = await this.prisma.store.findUnique({ where: { id: dto.requestedStoreId } });
    if (!store || store.isAggregate) {
      throw new BadRequestException('Choose a valid store');
    }

    // The LOGIN identity is a generated, unique handle — never the personal email
    // (which is optional and may be shared). "shreyansh.mumbaibandra@eclatdiamonds.in".
    const email = await uniqueEmailHandle(dto.name, store.name, async (candidate) =>
      !!(await this.prisma.user.findUnique({ where: { email: candidate }, select: { id: true } })),
    );

    const passwordHash = await bcrypt.hash(dto.password, 10);
    await this.prisma.user.create({
      data: {
        name: dto.name.trim(),
        email,
        contactEmail,
        phone,
        initials: dto.name.trim().slice(0, 2).toUpperCase(),
        // NEVER the requested role — a pending row is powerless until approved.
        role: 'salesperson',
        passwordHash,
        isActive: false,
        approvalStatus: 'pending',
        requestedRole: dto.requestedRole,
        requestedStoreId: dto.requestedStoreId,
      },
    });

    return {
      pending: true,
      loginEmail: email,
      message:
        dto.requestedRole === 'salesperson'
          ? 'Request sent. Your store manager will approve your account.'
          : 'Request sent. Head office will approve your account.',
    };
  }

  async login(email: string, password: string) {
    const key = email.toLowerCase();
    // Checked BEFORE the DB lookup, and failures are recorded for unknown handles
    // too, so lockout behaviour never reveals which handles are real accounts.
    if (this.lockout.isLocked(key)) {
      throw new UnauthorizedException('Too many failed attempts. Try again in a few minutes.');
    }

    const user = await this.prisma.user.findUnique({ where: { email: key } });
    // isActive already blocks pending/rejected (both are isActive=false); the
    // explicit approvalStatus check is defence-in-depth. Same generic message
    // for every case so login never reveals which emails exist or their status.
    if (!user || !user.passwordHash || !user.isActive || user.approvalStatus !== 'approved') {
      this.lockout.fail(key);
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      this.lockout.fail(key);
      throw new UnauthorizedException('Invalid credentials');
    }
    this.lockout.clear(key); // clean login clears the counter

    const token = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    });

    const session = await this.buildSession(user.id, user.role);
    return { token, ...session };
  }

  /** GET /auth/me payload — matches the frontend `useSession` Session shape. */
  async me(auth: AuthUser) {
    return this.buildSession(auth.id, auth.role);
  }

  /** POST /auth/change-password — verify current password, then store a new hash. */
  async changePassword(auth: AuthUser, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.id } });
    const ok = !!user.passwordHash && (await bcrypt.compare(currentPassword, user.passwordHash));
    if (!ok) throw new UnauthorizedException('Current password is incorrect');

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // WhatsApp OTP login
  // ------------------------------------------------------------------

  /**
   * Normalize a phone to its last 10 digits (Indian mobile). "+91 91000-00001",
   * "09100000001" and "9100000001" all compare equal. Throws 400 when fewer
   * than 10 digits remain.
   */
  private normalizePhone(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10) {
      throw new BadRequestException('Enter a valid 10-digit mobile number');
    }
    return digits.slice(-10);
  }

  /** Find the ACTIVE user whose stored phone matches on the last 10 digits. */
  private async findUserByPhone(last10: string) {
    // User.phone is NOT unique in the DB (legacy data risk) — match in code.
    const candidates = await this.prisma.user.findMany({
      where: { isActive: true, phone: { not: null } },
      orderBy: { createdAt: 'desc' }, // deterministic pick if legacy duplicates exist
    });
    return (
      candidates.find((u) => {
        const digits = (u.phone ?? '').replace(/\D/g, '');
        return digits.length >= 10 && digits.slice(-10) === last10;
      }) ?? null
    );
  }

  /**
   * POST /auth/otp/request — send a 6-digit sign-in code over WhatsApp.
   * Never reveals whether a phone belongs to an account: unknown phones get the
   * same `{sent: true}` response, we just don't create or send anything.
   */
  async requestOtp(phone: string) {
    const last10 = this.normalizePhone(phone);
    const dryRun = !this.whatsapp.enabled;

    // Rate limits (rows only ever exist for real accounts).
    const now = Date.now();
    const recent = await this.prisma.loginOtp.findFirst({
      where: {
        phone: last10,
        consumedAt: null,
        createdAt: { gt: new Date(now - OTP_RESEND_COOLDOWN_MS) },
      },
    });
    if (recent) {
      throw new HttpException(
        'Please wait before requesting another code.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const lastHour = await this.prisma.loginOtp.count({
      where: { phone: last10, createdAt: { gt: new Date(now - 60 * 60 * 1000) } },
    });
    if (lastHour >= OTP_MAX_PER_HOUR) {
      throw new HttpException(
        'Too many codes requested — please try again in an hour.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.findUserByPhone(last10);
    if (!user) return { sent: true, dryRun }; // do NOT leak which phones exist

    // crypto.randomInt — never Math.random for auth codes.
    const code = String(randomInt(100000, 999999));
    const codeHash = await bcrypt.hash(code, 10);
    await this.prisma.loginOtp.create({
      data: { phone: last10, codeHash, expiresAt: new Date(now + OTP_TTL_MS) },
    });

    const result = await this.whatsapp.sendText(
      user.phone!,
      `Your Eclat sign-in code is ${code}. It expires in 5 minutes. Do not share it.`,
    );
    if (result.dryRun) {
      // WhatsApp unconfigured: surface the code in server logs ONLY, so cloud
      // testing works via deploy logs. Never logged when sending is live.
      this.logger.log(`[OTP dry-run] phone=${last10} code=${code}`);
    }

    return { sent: true, dryRun: result.dryRun };
  }

  /** POST /auth/otp/verify — exchange phone + code for the same session as /auth/login. */
  async verifyOtp(phone: string, code: string) {
    const last10 = this.normalizePhone(phone);

    const otp = await this.prisma.loginOtp.findFirst({
      where: { phone: last10, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw new UnauthorizedException('Code expired or not found.');
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      throw new UnauthorizedException('Too many attempts — request a new code.');
    }

    const ok = await bcrypt.compare(code, otp.codeHash);
    if (!ok) {
      await this.prisma.loginOtp.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException('Incorrect code.');
    }

    await this.prisma.loginOtp.update({
      where: { id: otp.id },
      data: { consumedAt: new Date() },
    });

    const user = await this.findUserByPhone(last10);
    if (!user) throw new UnauthorizedException('Code expired or not found.');

    // Same login response shape as POST /auth/login.
    const token = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    });
    const session = await this.buildSession(user.id, user.role);
    return { token, ...session };
  }

  /**
   * POST /auth/reset-password — a manager sets a new password for a user in
   * their scope (store overlap; head_office = anyone). A caller may only reset
   * users ranked BELOW their own role — never peers or superiors.
   */
  async resetPassword(actor: AuthUser, userId: string, newPassword: string) {
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { userStores: { select: { storeId: true } } },
    });
    if (!target) throw new NotFoundException('User not found');

    if (actor.role !== 'head_office') {
      if (ROLE_RANK[target.role] >= ROLE_RANK[actor.role]) {
        throw new ForbiddenException('You can only reset passwords for roles below your own');
      }
      const targetStores = target.userStores.map((us) => us.storeId);
      const overlap = targetStores.some((s) => actor.storeIds.includes(s));
      if (!overlap) throw new ForbiddenException('User is not in your store scope');
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({ where: { id: target.id }, data: { passwordHash } });
    return { ok: true };
  }

  private async buildSession(userId: string, role: AuthUser['role']) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const { storeIds, allStores } = await this.scope.resolveScope(userId, role);

    const stores = await this.prisma.store.findMany({
      where: allStores ? { isAggregate: false } : { id: { in: storeIds } },
      orderBy: { name: 'asc' },
    });

    // Broad roles get the synthetic "All Stores" aggregate appended (frontend ALL_STORES).
    const aggregate = await this.prisma.store.findFirst({ where: { isAggregate: true } });
    const storeViews = stores.map(storeView);
    if ((allStores || role === 'area_manager') && aggregate) {
      storeViews.push(storeView(aggregate));
    }

    // Broad roles (head office / area manager) land on the pan-India "All Stores"
    // aggregate by default; single-store users land on their own store.
    const currentStore = storeViews.find((s) => s.isAggregate) ?? storeViews[0];

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        initials: user.initials ?? user.name.slice(0, 2).toUpperCase(),
      },
      role,
      stores: storeViews,
      currentStore,
    };
  }
}
