import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { InStoreService } from './instore.service';
import {
  InStoreSearchDto,
  LeadFeedDto,
  RecordVisitDto,
  ScanItemDto,
} from './dto/instore.dto';

/**
 * The floor application's API.
 *
 * Salesperson-level on purpose: this is the one screen the people who actually
 * meet customers use, and gating it at manager level would make it useless.
 * Everything it returns is already narrowed by the caller's own branches, so a
 * salesperson sees their counter's customers and nobody else's.
 */
@Roles('salesperson')
@Controller('instore')
export class InStoreController {
  constructor(private readonly instore: InStoreService) {}

  @Get('leads')
  leads(@CurrentUser() user: AuthUser, @Query() query: LeadFeedDto) {
    return this.instore.leadFeed(user, query);
  }

  /** Partial phone, name or customer code. */
  @Get('search')
  search(@CurrentUser() user: AuthUser, @Query() query: InStoreSearchDto) {
    return this.instore.search(user, query.q);
  }

  @Get('customers/:partyId')
  profile(@CurrentUser() user: AuthUser, @Param('partyId') partyId: string) {
    return this.instore.profile(user, partyId);
  }

  /**
   * GET, not POST: scanning is a read, it is safe to repeat, and a scanner that
   * fires twice must not create anything.
   */
  @Get('scan')
  scan(@CurrentUser() user: AuthUser, @Query() query: ScanItemDto) {
    return this.instore.lookupItem(user, query.code);
  }

  @Post('visits')
  recordVisit(@CurrentUser() user: AuthUser, @Body() body: RecordVisitDto) {
    return this.instore.recordVisit(user, body);
  }
}
