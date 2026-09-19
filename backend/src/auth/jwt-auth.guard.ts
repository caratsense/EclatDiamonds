import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { effectiveAccess } from './access';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { IS_PUBLIC_KEY } from './public.decorator';
import { StoreScopeService } from '../common/store-scope.service';
import { AuthUser } from '../common/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { adoptTenant } from '../common/tenant-context';
import {
  ALLOW_MACHINE_KEY,
  HUMANS_ONLY_KEY,
  MachineAccess,
  ORGANISATION_WIDE_MACHINE_KEY,
} from './machine.decorator';
import { AGENT_TOKEN_PREFIX, ConnectService } from '../integration/connect/connect.service';

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
    private readonly connect: ConnectService,
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

    // ---- machine principal (CaratOS Connect agent) -------------------------
    //
    // An agent token is recognisable by its prefix, and is accepted ONLY on
    // routes explicitly marked @AllowMachine(). Everywhere else it is refused
    // as an unknown credential — which is why an agent cannot wander into the
    // rest of the product even though it authenticates successfully here.
    if (token.startsWith(AGENT_TOKEN_PREFIX)) {
      const machineAccess = this.reflector.getAllAndOverride<MachineAccess>(ALLOW_MACHINE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!machineAccess) {
        throw new UnauthorizedException(
          'This credential belongs to a CaratOS Connect agent and cannot be used here.',
        );
      }
      const organisationWideOnly = this.reflector.getAllAndOverride<boolean>(
        ORGANISATION_WIDE_MACHINE_KEY,
        [context.getHandler(), context.getClass()],
      );
      const humansOnly = this.reflector.getAllAndOverride<boolean>(HUMANS_ONLY_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      return this.authenticateAgent(
        req,
        token,
        machineAccess,
        organisationWideOnly,
        humansOnly,
      );
    }

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
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        approvalStatus: true,
        organisationId: true,
        accessOverrides: true,
        // industryPackCode and the tenant's own module switches ride along on a
        // select that already runs, so the entitlement guard needs no query of
        // its own. `disabledCapabilities` is a plain text array and costs
        // nothing here; reading the same thing out of the shared `settings`
        // JSONB would have dragged branding, routing rules and the
        // qualification policy into every authenticated request.
        organisation: {
          select: { status: true, industryPackCode: true, disabledCapabilities: true },
        },
      },
    });
    // approvalStatus as well as isActive: a pending or rejected signup is
    // powerless even if something flips its active flag.
    if (!dbUser || !dbUser.isActive || dbUser.approvalStatus !== 'approved') {
      throw new UnauthorizedException('Account is inactive or no longer exists');
    }
    // Organisation comes from the authoritative DB user, never the token/frontend.
    // A user with no organisation cannot be scoped safely — fail closed.
    if (!dbUser.organisationId) {
      throw new UnauthorizedException('Account is not attached to an organisation');
    }
    // Tenant lifecycle (Phase A1). Read fresh alongside the user, so suspending a
    // tenant takes effect on its next request rather than at token expiry.
    // `onboarding` is allowed through deliberately: a tenant that cannot sign in
    // can never finish setting itself up.
    const orgStatus = dbUser.organisation?.status;
    if (orgStatus === 'suspended' || orgStatus === 'cancelled') {
      throw new UnauthorizedException(
        orgStatus === 'suspended'
          ? 'This organisation is suspended. Contact your administrator.'
          : 'This organisation is closed.',
      );
    }

    const { storeIds, allStores } = await this.scope.resolveScope(
      dbUser.id,
      dbUser.role,
      dbUser.organisationId,
    );
    const user: AuthUser = {
      id: dbUser.id,
      email: dbUser.email,
      name: dbUser.name,
      role: dbUser.role,
      organisationId: dbUser.organisationId,
      storeIds,
      allStores,
      industryPackCode: dbUser.organisation?.industryPackCode ?? null,
      disabledCapabilities: dbUser.organisation?.disabledCapabilities ?? [],
      access: effectiveAccess(dbUser.role, dbUser.accessOverrides),
    };
    // A machine must never reach a route marked @HumansOnly(). Checked for every
    // principal, not only machines, so the marker is a property of the ROUTE
    // rather than something only the agent path remembers to honour.
    this.assertHumanIfRequired(context, user);

    req.user = user;
    // Hand the resolved tenant to the ambient scope opened by
    // TenantContextMiddleware, so logs, jobs and (later) RLS see it without
    // every service having to thread it through. Authorization still rides on
    // the explicit AuthUser above — this is observability, not a second gate.
    adoptTenant({
      organisationId: dbUser.organisationId,
      userId: dbUser.id,
      actor: 'user',
      requestId: req.requestId,
    });
    return true;
  }

  /**
   * Resolve a CaratOS Connect agent token to a restricted principal.
   *
   * THE ORGANISATION COMES FROM THE TOKEN. The agent sends no organisation id —
   * there is nothing in the request that could steer which tenant it writes to,
   * which is the same rule the human path follows.
   *
   * The principal carries `head_office` because bulk ingestion legitimately
   * needs organisation-wide write reach, and `isMachine: true` because that
   * reach must still be distinguishable from a person's. Store scope is the
   * agent's own binding: an agent enrolled against one branch can write only
   * that branch's rows, while an organisation-wide agent gets every store of ITS
   * OWN organisation and no other.
   */
  private async authenticateAgent(
    req: any,
    token: string,
    machineAccess: MachineAccess,
    organisationWideOnly: boolean | undefined,
    humansOnly: boolean | undefined,
  ): Promise<boolean> {
    const agent = await this.connect.authenticate(token);

    if (humansOnly) {
      throw new ForbiddenException(
        'This action must be performed by a signed-in person, not an automated agent.',
      );
    }

    const agentConfig =
      agent.config && typeof agent.config === 'object' && !Array.isArray(agent.config)
        ? (agent.config as Record<string, unknown>)
        : {};
    if (Array.isArray(machineAccess)) {
      if (!machineAccess.includes(agent.sourceSystem)) {
        throw new ForbiddenException(
          `This ${agent.sourceSystem} connector is not allowed to use this ingestion route.`,
        );
      }
      if (agentConfig.enabled === false) {
        throw new ForbiddenException('This Connect agent is disabled by the server.');
      }
    }
    if (organisationWideOnly && agent.storeId) {
      throw new ForbiddenException(
        'A store-bound Connect agent cannot use the organisation-wide legacy sync surface.',
      );
    }

    const org = await this.prisma.organisation.findUnique({
      where: { id: agent.organisationId },
      select: { status: true },
    });
    // The same tenant-lifecycle gate humans get. A suspended tenant's agent must
    // stop pushing data, or a cancelled account keeps growing.
    if (org?.status === 'suspended' || org?.status === 'cancelled') {
      throw new UnauthorizedException('This organisation is not active.');
    }

    const stores = await this.prisma.store.findMany({
      where: {
        organisationId: agent.organisationId,
        isAggregate: false,
        ...(agent.storeId ? { id: agent.storeId } : {}),
      },
      select: { id: true },
    });

    const user: AuthUser = {
      id: `agent:${agent.id}`,
      name: agent.name,
      email: '',
      role: 'head_office',
      organisationId: agent.organisationId,
      storeIds: stores.map((s) => s.id),
      allStores: !agent.storeId,
      isMachine: true,
      agentId: agent.id,
      // These bind the entire request to the token/config generation accepted
      // above. Long imports re-check them at each persistence boundary.
      agentTokenHash: agent.tokenHash,
      agentConfigRevision:
        typeof agentConfig.configRevision === 'string'
          ? agentConfig.configRevision
          : '1',
      connectorSourceSystem: agent.sourceSystem,
    };
    req.user = user;

    adoptTenant({
      organisationId: agent.organisationId,
      actor: 'connector',
      requestId: req.requestId,
    });
    return true;
  }

  /** Refuse a machine principal on a route reserved for people. */
  private assertHumanIfRequired(context: ExecutionContext, user: AuthUser): void {
    const humansOnly = this.reflector.getAllAndOverride<boolean>(HUMANS_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (humansOnly && user.isMachine) {
      throw new ForbiddenException(
        'This action destroys data and must be performed by a signed-in person, not an automated agent.',
      );
    }
  }
}
