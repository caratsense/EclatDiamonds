import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Permit } from '../auth/permissions';

import { AuthUser, CurrentUser } from '../common/auth-user';
import { Roles } from '../auth/roles.decorator';
import { TenantConfigService } from './tenant-config.service';
import {
  ApplyPackDto,
  SetCapabilitiesDto,
  CreateTermDto,
  UpdateTermDto,
  UpsertAttributeDto,
  UpsertFieldPolicyDto,
} from './dto/tenant-config.dto';

/**
 * Tenant configuration API (CaratOS Phase A2).
 *
 * READS are open to any authenticated user — every screen needs the bootstrap
 * payload to render its own labels and option lists. WRITES are head_office
 * only: changing a vocabulary changes what every store sees, so it is an
 * organisation-level act, not a store-level one.
 *
 * No route takes an organisation id. The tenant is the caller's, always.
 */
@Controller('config')
export class TenantConfigController {
  constructor(private readonly config: TenantConfigService) {}

  /**
   * GET /config/bootstrap — the single call a client makes on load to learn what
   * this tenant is, what it calls things, and which fields to show.
   */
  @Permit('session')
  @Get('bootstrap')
  bootstrap(@CurrentUser() user: AuthUser) {
    return this.config.bootstrap(user);
  }

  /** GET /config/packs — the industry choices offered during onboarding. */
  @Get('packs')
  packs() {
    return this.config.availablePacks();
  }

  /** POST /config/packs/apply — choose or upgrade the industry pack. Additive. */
  @Roles('head_office')
  @Post('packs/apply')
  applyPack(@CurrentUser() user: AuthUser, @Body() body: ApplyPackDto) {
    return this.config.applyPack(user, body.packCode);
  }

  /**
   * GET /config/capabilities — which of this industry's modules are on.
   *
   * Readable by any signed-in user, like the rest of the configuration reads: a
   * salesperson's client needs to know the same thing the sidebar does.
   */
  @Permit('session')
  @Get('capabilities')
  capabilities(@CurrentUser() user: AuthUser) {
    return this.config.capabilities(user);
  }

  /**
   * PUT /config/capabilities — switch modules off, or back on.
   *
   * Head office only. Switching a module off changes what every person in every
   * branch can reach, and the same list gates the API — so this is not a display
   * preference, it is an authorisation change, and it is audited as one.
   */
  @Roles('head_office')
  @Put('capabilities')
  setCapabilities(@CurrentUser() user: AuthUser, @Body() body: SetCapabilitiesDto) {
    return this.config.setCapabilities(user, { disabled: body.disabled });
  }

  @Permit('session')
  @Get('taxonomy')
  listTerms(
    @CurrentUser() user: AuthUser,
    @Query('kind') kind?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.config.listTerms(user, kind, includeInactive === 'true');
  }

  @Roles('head_office')
  @Post('taxonomy')
  createTerm(@CurrentUser() user: AuthUser, @Body() body: CreateTermDto) {
    return this.config.createTerm(user, body);
  }

  @Roles('head_office')
  @Patch('taxonomy/:id')
  updateTerm(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: UpdateTermDto) {
    return this.config.updateTerm(user, id, body);
  }

  /** Deactivates rather than deletes — historical rows keep their label. */
  @Roles('head_office')
  @Delete('taxonomy/:id')
  deactivateTerm(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.config.deactivateTerm(user, id);
  }

  @Roles('head_office')
  @Post('attributes')
  upsertAttribute(@CurrentUser() user: AuthUser, @Body() body: UpsertAttributeDto) {
    return this.config.upsertAttribute(user, body);
  }

  /** Hides the field; values already stored in each row's JSON are kept. */
  @Roles('head_office')
  @Delete('attributes/:id')
  deactivateAttribute(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.config.deactivateAttribute(user, id);
  }

  @Roles('head_office')
  @Post('field-policy')
  upsertFieldPolicy(@CurrentUser() user: AuthUser, @Body() body: UpsertFieldPolicyDto) {
    return this.config.upsertFieldPolicy(user, body);
  }
}
