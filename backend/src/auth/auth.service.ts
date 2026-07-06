import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { AuthUser } from '../common/auth-user';

/** Public shape of a store as the frontend expects it. */
function storeView(s: { id: string; name: string; city: string; isAggregate: boolean }) {
  return { id: s.id, name: s.name, city: s.city, isAggregate: s.isAggregate || undefined };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly scope: StoreScopeService,
    private readonly config: ConfigService,
  ) {}

  /**
   * POST /auth/google — sign in with a Google ID token (from Google Identity
   * Services on the frontend). We verify the token with Google, then match an
   * EXISTING active user by email — we never auto-create accounts (an internal
   * ops tool: the admin provisions users; Google just authenticates them).
   * Code-complete behind GOOGLE_CLIENT_ID; returns 400 until it's configured.
   */
  async loginWithGoogle(credential: string) {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID');
    if (!clientId) throw new BadRequestException('Google sign-in is not configured');

    let payload: any;
    try {
      const res = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`,
      );
      if (!res.ok) throw new Error(`tokeninfo ${res.status}`);
      payload = await res.json();
    } catch {
      throw new UnauthorizedException('Could not verify Google sign-in');
    }

    const audOk = payload.aud === clientId;
    const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
    const email = String(payload.email ?? '').toLowerCase();
    if (!audOk || !emailVerified || !email) {
      throw new UnauthorizedException('Invalid Google sign-in');
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException(
        'No CaratSense account for this Google email — ask an admin to add you.',
      );
    }

    const token = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    });
    const session = await this.buildSession(user.id, user.role);
    return { token, ...session };
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || !user.passwordHash || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

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
