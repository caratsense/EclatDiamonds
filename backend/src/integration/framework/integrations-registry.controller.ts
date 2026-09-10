import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { AuthUser, CurrentUser } from '../../common/auth-user';
import { Roles } from '../../auth/roles.decorator';
import { IntegrationsRegistryService } from './integrations-registry.service';

class CreateIntegrationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  providerCode!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  /** Non-secret settings only. A secret sent here would be stored in the clear. */
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

class UpdateIntegrationConfigDto {
  /** Non-secret settings only. The service refuses anything credential-shaped. */
  @IsObject()
  config!: Record<string, unknown>;
}

class SetCredentialDto {
  @IsString()
  @IsIn(['api_key', 'api_secret', 'access_token', 'refresh_token', 'password', 'shared_secret', 'app_secret', 'webhook_secret', 'webhook_verify_token'])
  kind!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  secret!: string;
}

class SetIntegrationAssetDto {
  @IsString()
  @IsIn(['phone_number'])
  kind!: string;

  @IsString()
  @Matches(/^[1-9]\d{5,31}$/, {
    message: 'externalId must be a WhatsApp phone number ID containing 6 to 32 digits',
  })
  externalId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;
}

/**
 * Tenant integration configuration (CaratOS Phase A5).
 *
 * Head office only: connecting a provider is an organisation-level act, and the
 * credentials involved authenticate as the whole business.
 *
 * NO ROUTE ON THIS CONTROLLER RETURNS A SECRET. There is deliberately no
 * "reveal" or "test with echo" endpoint — once written, a credential is only ever
 * readable by server-side adapters.
 */
@Roles('head_office')
@Controller('integrations-registry')
export class IntegrationsRegistryController {
  constructor(private readonly registry: IntegrationsRegistryService) {}

  /** The provider catalogue, including what is blocked and why. */
  @Get('providers')
  providers(@CurrentUser() user: AuthUser) {
    return this.registry.catalogue(user);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.registry.list(user);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.registry.get(user, id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: CreateIntegrationDto) {
    return this.registry.create(user, {
      providerCode: body.providerCode,
      name: body.name,
      config: body.config as never,
    });
  }

  /** Replace non-secret settings on an existing connection. */
  @Patch(':id/config')
  updateConfig(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: UpdateIntegrationConfigDto,
  ) {
    return this.registry.updateConfig(user, id, body.config as never);
  }

  /** Re-wrap this tenant's stored secrets during a master-key rotation. */
  @Post('credentials/rewrap')
  rewrapCredentials(@CurrentUser() user: AuthUser) {
    return this.registry.rewrapCredentials(user);
  }

  /** Store a secret. Encrypted before it touches the database. */
  @Post(':id/credentials')
  setCredential(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: SetCredentialDto,
  ) {
    return this.registry.setCredential(user, id, body.kind, body.secret);
  }

  /** Register the non-secret phone-number identity paired with a tenant token. */
  @Post(':id/assets')
  setAsset(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: SetIntegrationAssetDto,
  ) {
    return this.registry.setAsset(user, id, body);
  }

  @Delete(':id/credentials/:kind')
  deleteCredential(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('kind') kind: string,
  ) {
    return this.registry.deleteCredential(user, id, kind);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.registry.remove(user, id);
  }
}
