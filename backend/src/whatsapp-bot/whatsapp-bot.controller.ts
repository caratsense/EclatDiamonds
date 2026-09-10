import { Controller, Get, Param, Post } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { WhatsAppIdentityService } from './whatsapp-identity.service';

/**
 * WhatsApp bot management (internal reporting bot). Linking a number is a
 * self-service action any signed-in user may do for themselves; listing and
 * revoking bindings is a manager+ action, store-scoped in the service.
 */
@Controller('whatsapp')
export class WhatsAppBotController {
  constructor(private readonly identity: WhatsAppIdentityService) {}

  /** Start linking my own WhatsApp number — returns a one-time code to send to the bot. */
  @Post('link/start')
  startLink(@CurrentUser() user: AuthUser) {
    return this.identity.startLinking(user);
  }

  /** List bound numbers for users inside my store scope. */
  @Roles('store_manager', 'area_manager', 'head_office')
  @Get('identities')
  list(@CurrentUser() user: AuthUser) {
    return this.identity.listInScope(user);
  }

  /** Unbind a number (offboarding, lost handset, wrong link). */
  @Roles('store_manager', 'area_manager', 'head_office')
  @Post('identities/:id/revoke')
  revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.identity.revokeById(user, id);
  }
}
