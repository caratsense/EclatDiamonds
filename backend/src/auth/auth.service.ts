import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { randomInt, randomUUID } from 'crypto';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { ROLE_RANK } from '../common/role.util';
import { WhatsAppService } from '../integrations/whatsapp.service';
import { SignupDto } from './dto/signup.dto';
import { CreateOrganisationDto } from './dto/create-organisation.dto';
import { uniqueEmailHandle } from '../users/users.util';
import { LoginLockout } from './login-lockout';
import { DEFAULT_PACK_CODE, getPack, listPacks } from '../config/industry-packs/packs';
import { enabledCapabilitiesFor } from '../config/entitlements';
import { provisionIndustryPack } from '../config/industry-packs/provision';
import { packQuestions } from '../config/industry-packs/pack-managed';
import { DEFAULT_QUALIFICATION_POLICY } from '../crm/qualification-policy';

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

function organisationSlug(name: string): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 42) || 'organisation';
  // Always suffix: public signup must stay race-safe without a read-then-create
  // uniqueness window, and the slug is an identifier rather than a brand label.
  return `${base}-${randomUUID().slice(0, 8)}`;
}

function initialsOf(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || name.trim().slice(0, 2).toUpperCase()
  );
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
      organisationId: user.organisationId ?? '',
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

    const store = await this.prisma.store.findUnique({
      where: { id: dto.requestedStoreId },
      // The organisation's slug scopes the generated login handle to this tenant.
      include: { organisation: { select: { slug: true } } },
    });
    if (!store || store.isAggregate) {
      throw new BadRequestException('Choose a valid store');
    }
    // Organisation is resolved from the EXPLICITLY chosen store — a trusted signal,
    // never a first-store/alphabetical/Surat fallback. A store with no organisation
    // cannot attribute a signup, so refuse rather than guess.
    if (!store.organisationId) {
      throw new BadRequestException('That store is not available for signup');
    }

    // The LOGIN identity is a generated, unique handle — never the personal email
    // (which is optional and may be shared) — and it is scoped to the tenant that
    // owns the chosen store: "priya.andheri@sunrise-clinic.accounts.caratos.invalid".
    const email = await uniqueEmailHandle(
      dto.name,
      store.name,
      store.organisation?.slug,
      async (candidate) =>
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
        // Organisation of the explicitly chosen store — the pending user belongs to
        // that tenant from the moment they sign up (approval never crosses orgs).
        organisationId: store.organisationId,
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

  /** Public, non-secret catalogue used by the create-organisation screen. */
  availableIndustries() {
    return { packs: listPacks(), defaultPackCode: DEFAULT_PACK_CODE };
  }

  /**
   * Create a brand-new tenant and its first owner/location as one transaction.
   * This is deliberately separate from employee self-signup: an employee may
   * request access to an existing tenant, while this route may grant head_office
   * only inside the tenant it creates itself.
   */
  async createOrganisation(dto: CreateOrganisationDto) {
    const pack = getPack(dto.industryCode);
    if (!pack) {
      throw new BadRequestException(
        `Choose a supported industry: ${listPacks().map((item) => item.code).join(', ')}.`,
      );
    }

    const email = dto.email.trim().toLowerCase();
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existingUser) {
      /*
       * Deliberately generic, and deliberately the same sentence whatever the
       * cause.
       *
       * This endpoint is PUBLIC and matches on email across every tenant, so a
       * precise "that account exists" answered, for anyone who cared to ask,
       * whether a given person banks with a competitor of ours. /auth/login
       * already refuses to leak that (it returns one message for a bad email and
       * a bad password alike); this route was the hole in the same wall.
       *
       * The cost is a worse message for the honest case, so the text points at
       * the two things a real signer-up can actually do about it.
       */
      throw new ConflictException(
        'We could not create an organisation with those details. If you already have a ' +
          'CaratOS account, sign in instead — or ask your administrator to invite you.',
      );
    }

    const organisationName = dto.organisationName.trim();
    const ownerName = dto.ownerName.trim();
    const primaryLocationName = dto.primaryLocationName.trim();
    const city = dto.city.trim();
    const slug = organisationSlug(organisationName);
    const passwordHash = await bcrypt.hash(dto.password, 10);

    // AI qualification and drafting are non-sending assistance. Auto-send is
    // always false until the owner explicitly enables it after connecting a
    // provider/channel. No existing tenant credential is copied or referenced.
    const settings = {
      branding: { displayName: organisationName },
      featureProfile: {
        industryCode: pack.code,
        /*
         * `enabledNavigation` is NOT stored here any more.
         *
         * It used to be frozen into this object at signup and never rewritten,
         * so a tenant who changed industry afterwards kept the original
         * industry's menu for ever. Both the sidebar and the entitlement guard
         * now derive it from the applied pack on every read — one answer, always
         * current — and a second copy here could only go stale and disagree.
         */
        mandatoryCapabilities: [
          'omnichannel_crm',
          'ai_catalogue',
          'attendance',
          'imports',
          'integrations',
        ],
      },
      crmAiQualificationEnabled: true,
      crmAiDraftEnabled: true,
      crmAiAutoSendEnabled: false,
      /*
       * `crmAiIndustryContext` and `crmQualificationFields` are no longer
       * written. Both were dead: a repo-wide search found this line as their
       * only mention, with no reader anywhere. The industry's AI context now
       * comes from the pack on every read (GET /config/bootstrap →
       * industry.aiContext), and the qualification fields live where they are
       * actually used — as the structured questions below.
       */
      crmQualification: {
        ...DEFAULT_QUALIFICATION_POLICY,
        /*
         * Left at the platform default, which is OFF.
         *
         * Signup used to force this true, contradicting
         * DEFAULT_QUALIFICATION_POLICY and the comment beside it: "turning on an
         * assessment that starts scoring people the moment the code ships is not
         * a decision the platform gets to make". A brand-new tenant is exactly
         * the case that comment is about — nobody has read the policy, and no
         * knowledge has been loaded for it to score against. Head office turns
         * it on from the configuration screen when they mean to.
         */
        questions: packQuestions(pack),
      },
      attendanceSetupRequired: true,
      catalogueMode: 'ai_assisted',
    };

    let created: {
      organisation: { id: string; name: string; slug: string };
      owner: { id: string; name: string; email: string; role: AuthUser['role'] };
      store: { id: string };
      packCounts: Awaited<ReturnType<typeof provisionIndustryPack>>;
    };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const organisation = await tx.organisation.create({
          data: {
            name: organisationName,
            slug,
            status: 'onboarding',
            country: 'IN',
            currency: 'INR',
            timezone: 'Asia/Kolkata',
            settings: settings as unknown as Prisma.InputJsonValue,
          },
          select: { id: true, name: true, slug: true },
        });

        const region = await tx.region.create({
          data: {
            organisationId: organisation.id,
            name: 'Primary region',
            code: 'PRIMARY',
          },
          select: { id: true },
        });
        const store = await tx.store.create({
          data: {
            organisationId: organisation.id,
            regionId: region.id,
            name: primaryLocationName,
            city,
            code: 'main',
            status: 'active',
            isActive: true,
            country: 'IN',
            email,
            timezone: 'Asia/Kolkata',
          },
          select: { id: true },
        });
        const owner = await tx.user.create({
          data: {
            organisationId: organisation.id,
            name: ownerName,
            email,
            contactEmail: email,
            phone: dto.phone?.trim() || null,
            initials: initialsOf(ownerName),
            role: 'head_office',
            passwordHash,
            isActive: true,
            approvalStatus: 'approved',
          },
          select: { id: true, name: true, email: true, role: true },
        });
        await tx.userStore.create({
          data: {
            userId: owner.id,
            storeId: store.id,
            role: 'head_office',
            isPrimary: true,
          },
        });

        const packCounts = await provisionIndustryPack(tx, organisation.id, pack);
        return { organisation, owner, store, packCounts };
      }, { maxWait: 5_000, timeout: 20_000 });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(
          'That login or organisation identifier is already in use. Try signing in instead.',
        );
      }
      throw err;
    }

    const actor: AuthUser = {
      id: created.owner.id,
      name: created.owner.name,
      email: created.owner.email,
      role: created.owner.role,
      organisationId: created.organisation.id,
      storeIds: [created.store.id],
      allStores: true,
    };
    await this.audit.record(actor, {
      action: 'organisation.self_service_created',
      entityType: 'Organisation',
      entityId: created.organisation.id,
      storeId: created.store.id,
      summary: `Created organisation ${created.organisation.name} with ${pack.name}`,
      metadata: {
        industryCode: pack.code,
        industryVersion: pack.version,
        ...created.packCounts,
      },
    });

    const token = await this.jwt.signAsync({
      sub: created.owner.id,
      email: created.owner.email,
      name: created.owner.name,
      role: created.owner.role,
    });
    const session = await this.buildSession(created.owner.id, created.owner.role);
    return {
      token,
      ...session,
      organisation: {
        id: created.organisation.id,
        name: created.organisation.name,
        slug: created.organisation.slug,
        industryCode: pack.code,
        industryName: pack.name,
      },
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

  /**
   * Find the ACTIVE user whose stored phone matches on the last 10 digits.
   *
   * Phone is NOT unique in the DB and there is NO tenant-aware login context yet
   * (no subdomain/slug resolving the org at OTP time), so a last-10 match can span
   * organisations. Rather than silently pick one — which could authenticate into
   * the WRONG org — we FAIL CLOSED: if the match resolves to more than one active
   * user, or to more than one organisation, return null (OTP simply won't send /
   * verify). This only prevents wrong-org resolution; it does NOT enable the same
   * phone to log in to two orgs. The real fix is a tenant-aware login flow that
   * resolves the org up front (see report).
   */
  private async findUserByPhone(last10: string) {
    const candidates = await this.prisma.user.findMany({
      where: { isActive: true, phone: { not: null } },
    });
    const matches = candidates.filter((u) => {
      const digits = (u.phone ?? '').replace(/\D/g, '');
      return digits.length >= 10 && digits.slice(-10) === last10;
    });
    if (matches.length !== 1) return null; // 0 = unknown, >1 = ambiguous → fail closed
    return matches[0];
  }

  /**
   * POST /auth/otp/request — send a 6-digit sign-in code over WhatsApp.
   * Never reveals whether a phone belongs to an account: unknown phones get the
   * same `{sent: true}` response, we just don't create or send anything.
   */
  async requestOtp(phone: string) {
    const last10 = this.normalizePhone(phone);

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
    // Whether sending is possible is now a property of the USER'S organisation,
    // which we only know once the user is found. For an unknown phone we report
    // the platform-neutral `dryRun: false` — the response must look identical
    // either way, or it becomes an oracle for which numbers have accounts.
    if (!user) return { sent: true, dryRun: false };

    // crypto.randomInt — never Math.random for auth codes.
    const code = String(randomInt(100000, 999999));
    const codeHash = await bcrypt.hash(code, 10);
    await this.prisma.loginOtp.create({
      data: { phone: last10, codeHash, expiresAt: new Date(now + OTP_TTL_MS) },
    });

    // The OTP goes out on the number belonging to the USER'S OWN organisation.
    // Resolved from the looked-up user record, never from the request — the
    // caller supplies only a phone number and must not be able to influence
    // which tenant's sender is used.
    // WHICH number it leaves from, for a tenant with several.
    //
    // Their primary branch. Not because a sign-in code belongs to a branch — it
    // does not — but because a tenant with eight numbers has no single "the"
    // number, and an unrouted send is refused. Refusing would lock somebody out
    // of the product over a messaging setting, so the branch they work at is
    // named here; the code still reaches them from a number their own business
    // owns.
    const primaryStore = await this.prisma.userStore.findFirst({
      where: { userId: user.id },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      select: { storeId: true },
    });
    const result = await this.whatsapp.sendText(
      user.organisationId!,
      user.phone!,
      `Your Eclat sign-in code is ${code}. It expires in 5 minutes. Do not share it.`,
      { storeId: primaryStore?.storeId ?? null },
    );
    const dryRun = result.dryRun;
    if (dryRun) {
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
    const organisation = user.organisationId
      ? await this.prisma.organisation.findUnique({
          where: { id: user.organisationId },
          select: { industryPackCode: true, settings: true, disabledCapabilities: true },
        })
      : null;
    const { storeIds, allStores } = await this.scope.resolveScope(
      userId,
      role,
      user.organisationId ?? '',
    );

    // `storeIds` is already organisation-bounded (head_office => every store of the
    // user's org, never global), so filtering by it is inherently org-safe.
    const stores = await this.prisma.store.findMany({
      where: { id: { in: storeIds } },
      orderBy: { name: 'asc' },
    });

    // Broad roles get the synthetic "All Stores" aggregate appended — scoped to the
    // user's own organisation so it can never surface another tenant's aggregate.
    const aggregate = user.organisationId
      ? await this.prisma.store.findFirst({
          where: { isAggregate: true, organisationId: user.organisationId },
        })
      : null;
    const storeViews = stores.map(storeView);
    if ((allStores || role === 'area_manager') && aggregate) {
      storeViews.push(storeView(aggregate));
    }

    // The user's designated primary store, if one is flagged. `stores` is ordered
    // by name, so `storeViews[0]` is merely the alphabetically-first assignment —
    // landing a multi-store user there made every store-scoped default (the
    // geo-attendance anchor, DSR store, etc.) follow the wrong branch: a user
    // primary at Surat but also assigned Mumbai — Borivali defaulted to Borivali.
    const primary = await this.prisma.userStore.findFirst({
      where: { userId, isPrimary: true },
      select: { storeId: true },
    });
    const primaryView = primary
      ? storeViews.find((s) => s.id === primary.storeId)
      : undefined;

    // Broad roles (head office / area manager) land on the pan-India "All Stores"
    // aggregate by default; everyone else lands on their PRIMARY store, falling
    // back to the first assignment only when none is flagged primary.
    const currentStore =
      storeViews.find((s) => s.isAggregate) ?? primaryView ?? storeViews[0];

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
      productProfile: {
        industryPackCode: organisation?.industryPackCode ?? null,
        /*
         * From the pack, not from stored settings.
         *
         * This value picks the post-login landing route, and reading it from the
         * frozen copy in settings meant a tenant who changed industry could be
         * sent, once per sign-in, to a screen their product no longer includes.
         * Deriving it here uses the same source GET /config/bootstrap uses, so
         * the destination is always inside the navigation the sidebar will draw.
         */
        // The same subtraction the config endpoint and the entitlement guard
        // make, so the navigation a user is handed at login cannot disagree
        // with what the server will actually let them open.
        enabledNavigation: enabledCapabilitiesFor(
          organisation?.industryPackCode,
          organisation?.disabledCapabilities,
        ),
      },
    };
  }
}


