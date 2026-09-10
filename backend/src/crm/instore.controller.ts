import { Body, Controller, Get, Header, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { InStoreService } from './instore.service';
import {
  FloorFormsDto,
  InStoreSearchDto,
  LeadFeedDto,
  RecordVisitDto,
  ScanItemDto,
  StoreDayDto,
  VisitFeedDto,
} from './dto/instore.dto';

/**
 * The floor application's API.
 *
 * Salesperson-level on purpose: this is the one screen the people who actually
 * meet customers use, and gating it at manager level would make it useless.
 *
 * Every LIST here — leads, visits, the day's figures, the capture forms — is
 * narrowed to the branches the caller actually works at. Customer SEARCH is the
 * one deliberate exception: a chain's customer who bought in Surat and walks
 * into Mumbai has to be recognised, so a party is findable across the tenant.
 * What does not travel with them is another branch's open enquiry.
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

  /**
   * One branch's visits for one of its own calendar days, with what each
   * customer asked about attached.
   *
   * Not `GET /checkins`: that one is the whole footfall log with no day
   * boundary, no paging and no enquiries.
   */
  @Get('visits')
  visits(@CurrentUser() user: AuthUser, @Query() query: VisitFeedDto) {
    return this.instore.visits(user, query);
  }

  /**
   * The photo taken at one visit.
   *
   * Bytes, not a redirect: the object's own URL never leaves the server.
   * Declared before `today`/`forms` is irrelevant — it is a distinct path — but
   * it IS declared after `visits` so the static segment cannot shadow it.
   */
  @Get('visits/:id/photo')
  @Header('Cache-Control', 'private, max-age=300')
  async visitPhoto(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { buffer, contentType } = await this.instore.visitPhoto(user, id);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buffer);
  }

  /** The branch's day as aggregates — every figure its own query. */
  @Get('today')
  today(@CurrentUser() user: AuthUser, @Query() query: StoreDayDto) {
    return this.instore.today(user, query);
  }

  /**
   * The capture forms for this counter, read-only.
   *
   * Creating one is a manager's act (it mints a key that lets anonymous callers
   * file leads into a branch); handing an existing one to the customer in front
   * of you is the floor's ordinary job.
   */
  @Get('forms')
  forms(@CurrentUser() user: AuthUser, @Query() query: FloorFormsDto) {
    return this.instore.forms(user, query);
  }
}
