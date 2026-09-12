import { Controller, Get, Param } from '@nestjs/common';

import { HumansOnly } from '../../auth/machine.decorator';
import { AuthUser, CurrentUser } from '../../common/auth-user';
import { ChannelAdaptersService } from './channel-adapters.service';

/**
 * What can actually reach a customer today.
 *
 * A read-only screen for the person who has to answer "why did that campaign
 * send nothing". Deliberately available to every signed-in role: a salesperson
 * who cannot see that Instagram is not connected will keep telling customers
 * somebody will message them there.
 *
 * No secret is in this payload — not a token, not a phone-number id, not a
 * signing secret. Only states, reasons and capability flags.
 */
@HumansOnly()
@Controller('adapters')
export class AdaptersController {
  constructor(private readonly adapters: ChannelAdaptersService) {}

  @Get()
  report(@CurrentUser() user: AuthUser) {
    return this.adapters.report(user.organisationId);
  }

  /** One channel, for a screen that only needs to explain itself. */
  @Get(':channel')
  one(@CurrentUser() user: AuthUser, @Param('channel') channel: string) {
    return this.adapters.deliverability(user.organisationId, channel);
  }
}
