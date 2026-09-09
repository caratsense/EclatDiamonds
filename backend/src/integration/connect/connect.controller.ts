import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { AllowMachine } from '../../auth/machine.decorator';
import { Roles } from '../../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../../common/auth-user';
import { ConnectService } from './connect.service';
import { RateLimit } from '../../common/rate-limit';

export class EnrolAgentDto {
  @IsString()
  @IsNotEmpty({ message: 'Give the agent a name you will recognise' })
  @MaxLength(80)
  name!: string;

  @IsString()
  @IsNotEmpty()
  sourceSystem!: string;

  @IsOptional()
  @IsString()
  storeId?: string;
}

export class ConfigureAgentDto {
  @IsObject()
  config!: Record<string, unknown>;
}

export class HeartbeatDto {
  @IsOptional() @IsString() @MaxLength(40) agentVersion?: string;
  @IsOptional() @IsString() @MaxLength(120) hostname?: string;
  @IsOptional() @IsString() @MaxLength(120) os?: string;
  @IsOptional() @IsIn(['active', 'error']) status?: 'active' | 'error';
  @IsOptional() @IsString() @MaxLength(2000) error?: string;
  @IsOptional() @IsObject() stats?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(40) syncedAt?: string;

  /**
   * NOTE THE ABSENCE. There is no `organisationId` here, and there must never
   * be one: the tenant is resolved from the agent's bearer token server-side.
   * Accepting it from the body would make the tenant a client-controlled input.
   */
}

/**
 * CaratOS Connect administration — the human side.
 *
 * Head office only: enrolling an agent mints a credential that can push data
 * into the organisation, which is not a store-level decision.
 */
@Roles('head_office')
@Controller('integration/connect/agents')
export class ConnectAdminController {
  constructor(private readonly connect: ConnectService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.connect.list(user);
  }

  /** Returns the plaintext token exactly once — see ConnectService.enrol. */
  @Post()
  enrol(@CurrentUser() user: AuthUser, @Body() dto: EnrolAgentDto) {
    return this.connect.enrol(user, dto);
  }

  @Post(':id/rotate')
  rotate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.connect.rotate(user, id);
  }

  @Post(':id/config')
  configure(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ConfigureAgentDto,
  ) {
    return this.connect.configure(user, id, dto.config);
  }

  @Delete(':id')
  revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.connect.revoke(user, id);
  }
}

/**
 * The agent's own endpoints.
 *
 * `@AllowMachine()` makes the global guard authenticate and attach the machine
 * principal before role/rate-limit guards run. Each handler reloads the complete
 * agent row for its response, but it is no longer treated as a public request.
 *
 * The surface is deliberately tiny. An agent can say who it is and what it has
 * done; it cannot read customers, cannot list stores, and cannot act as a user.
 * Data intake stays on explicitly machine-enabled endpoints. The legacy `/sync`
 * surface is Gati-only; BUSY/Tally/ODBC use canonical `/imports` preview/run.
 */
@AllowMachine()
// Agent heartbeats. Machine traffic, keyed on the agent's own identity so one
// misconfigured installation cannot exhaust its tenant's allowance.
@RateLimit('integration')
@Controller('integration/connect')
export class ConnectAgentController {
  constructor(private readonly connect: ConnectService) {}

  /**
   * Check in. The response tells the agent what the server wants next, so the
   * schedule and table list live in one place rather than in every installation.
   */
  @Post('heartbeat')
  async heartbeat(@Req() req: { headers: Record<string, string | undefined> }, @Body() dto: HeartbeatDto) {
    const token = bearer(req);
    const agent = await this.connect.authenticate(token);
    return this.connect.heartbeat(agent.id, token, dto);
  }

  /**
   * "Who am I, and am I still trusted?" — what an agent calls on start-up before
   * it does any work, so a revoked installation stops rather than retrying a
   * push that will be refused.
   */
  @Get('me')
  async me(@Req() req: { headers: Record<string, string | undefined> }) {
    const agent = await this.connect.authenticate(bearer(req));
    return this.connect.identity(agent);
  }
}

function bearer(req: { headers: Record<string, string | undefined> }): string | undefined {
  const header = req.headers['authorization'] ?? req.headers['Authorization'];
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}
