import { Controller, Get, Header, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { AuthUser, CurrentUser } from '../common/auth-user';
import { Roles } from '../auth/roles.decorator';
import { StoreHeader } from '../common/store-header.decorator';
import { NpsService } from './nps.service';
import { NPS_STAGES, NpsStage } from './nps-stage';

/**
 * CRM › NPS.
 *
 * Store manager and above, matching Feedback beside it: an NPS list is every
 * customer of a branch and what they thought of it, which is a management view
 * rather than a counter one. Store scoping still applies underneath, so a
 * manager sees their own branch and head office sees all of them.
 */
@Roles('store_manager')
@Controller('crm/nps')
export class NpsController {
  constructor(private readonly nps: NpsService) {}

  /** The stage vocabulary, so the UI filter cannot drift from the server's. */
  @Get('stages')
  stages() {
    return NPS_STAGES.map((value) => ({ value }));
  }

  /** One row per eligible visit, including customers who never responded. */
  @Get('updates')
  updates(
    @CurrentUser() user: AuthUser,
    @StoreHeader() storeId?: string,
    @Query('stage') stage?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.nps.updates(user, {
      storeId,
      stage: NPS_STAGES.includes(stage as NpsStage) ? (stage as NpsStage) : undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  /** Submissions, including the ones nobody could match yet. */
  @Get('responses')
  responses(
    @CurrentUser() user: AuthUser,
    @Query('matchState') matchState?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.nps.responses(user, {
      matchState: ['matched', 'unmatched', 'ambiguous'].includes(matchState ?? '')
        ? matchState
        : undefined,
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  /**
   * The whole authorised set across three tabs — Updates, Responses, Follow-ups
   * — not the page on screen.
   */
  @Get('export')
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async export(
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
    @StoreHeader() storeId?: string,
  ) {
    const { buffer, rows } = await this.nps.exportXlsx(user, { storeId });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="nps-${stamp}.xlsx"`);
    res.setHeader('X-Row-Count', String(rows));
    res.send(buffer);
  }
}
