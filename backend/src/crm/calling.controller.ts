import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { CallingService } from './calling.service';
import { CallingQueueDto, CallingSummaryDto, LogCallDto } from './dto/calling.dto';

/**
 * The calling / follow-up workspace.
 *
 * Salesperson-level: a tele-calling agent IS a salesperson in this system, and
 * the queue they work is their own. `mine` resolves to the caller server-side,
 * and every query is narrowed to the branches they can see.
 */
@Roles('salesperson')
@Controller('calling')
export class CallingController {
  constructor(private readonly calling: CallingService) {}

  /**
   * Counts computed as their own aggregates, never from the page below.
   *
   * `?storeId` wins over the header because the floor app names the counter it
   * is standing at explicitly; everywhere else the store switcher decides, and
   * before this it decided nothing here at all.
   */
  @Get('summary')
  summary(
    @CurrentUser() user: AuthUser,
    @Query() query: CallingSummaryDto,
    @StoreHeader() store?: string,
  ) {
    return this.calling.summary(user, { ...query, storeId: query.storeId ?? store });
  }

  @Get('queue')
  queue(
    @CurrentUser() user: AuthUser,
    @Query() query: CallingQueueDto,
    @StoreHeader() store?: string,
  ) {
    return this.calling.queue(user, { ...query, storeId: query.storeId ?? store });
  }

  @Get('tasks/:id')
  workspace(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.calling.workspace(user, id);
  }

  @Post('tasks/:id/calls')
  logCall(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: LogCallDto,
  ) {
    return this.calling.logCall(user, id, body);
  }

  @Get('customers/:partyId/calls')
  callsForParty(@CurrentUser() user: AuthUser, @Param('partyId') partyId: string) {
    return this.calling.callsForParty(user, partyId);
  }
}
