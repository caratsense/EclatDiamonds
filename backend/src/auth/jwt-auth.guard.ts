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

/**
 * Global guard. Validates the Bearer JWT, then resolves the caller's full
 * store-scope (UserStore + role rank) and attaches a complete AuthUser to
 * req.user so downstream services can store-scope every query.
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

    const { storeIds, allStores } = await this.scope.resolveScope(payload.sub, payload.role);
    const user: AuthUser = {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      role: payload.role,
      storeIds,
      allStores,
    };
    req.user = user;
    return true;
  }
}
