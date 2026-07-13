import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { IS_PUBLIC_KEY } from './public.decorator';
import { StoreScopeService } from '../common/store-scope.service';
import { AuthUser } from '../common/auth-user';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Global guard. Validates the Bearer JWT, then resolves the caller's full
 * store-scope (UserStore + role rank) and attaches a complete AuthUser to
 * req.user so downstream services can store-scope every query.
 *
 * The JWT only proves identity (sub). The caller's CURRENT role + active
 * status are read fresh from the DB on every request, never trusted from the
 * token body — so with long-lived (30d) tokens a promotion/demotion/disable
 * takes effect on the very next request without re-login, and a deactivated
 * account is locked out immediately (revocation-safe).
 *
 * Routes flagged with @Public() (login) skip auth.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly scope: StoreScopeService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const auth: string | undefined = req.headers['authorization'];
    if (!auth?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = auth.slice(7);

    let payload: { sub: string; email: string; name: string; role: AuthUser['role'] };
    try {
      payload = await this.jwt.verifyAsync(token, {
        secret: this.config.get<string>('JWT_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Single indexed lookup (User.id PK): the token only carries identity — the
    // authoritative role + active flag come from the DB every request.
    const dbUser = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });
    if (!dbUser || !dbUser.isActive) {
      throw new UnauthorizedException('Account is inactive or no longer exists');
    }

    const { storeIds, allStores } = await this.scope.resolveScope(dbUser.id, dbUser.role);
    const user: AuthUser = {
      id: dbUser.id,
      email: dbUser.email,
      name: dbUser.name,
      role: dbUser.role,
      storeIds,
      allStores,
    };
    req.user = user;
    return true;
  }
}
