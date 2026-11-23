import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';

import { AuthUser, CurrentUser } from '../common/auth-user';
import { RateLimit } from '../common/rate-limit';
import { Roles } from '../auth/roles.decorator';
import { StoreHeader } from '../common/store-header.decorator';
import { NpsImportDto } from './dto/nps-import.dto';
import { NpsService } from './nps.service';
import { NPS_STAGES, NpsStage } from './nps-stage';

/**
 * One sheet at a time, and 8 MiB of it — the same ceiling the onboarding
 * import uses. The client's whole ten-tab workbook is under 200 KiB, so this is
 * room for years of growth rather than a limit anybody will meet.
 */
const NPS_IMPORT_UPLOAD_OPTIONS = {
  limits: {
    fileSize: 8 * 1024 * 1024,
    files: 1,
    fields: 4,
    parts: 6,
    fieldNameSize: 128,
    fieldSize: 1024,
  },
};

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
   * Upload the client's NPS export (.xlsx or .csv).
   *
   * The counterpart of the export below, and the only way a response gets into
   * the system: the sheet is filled in by her Google Form, not by us. Re-upload
   * is the expected operation rather than an accident — the importers key on
   * the submission, so the same file twice updates the same rows.
   *
   * No store header: a submission is matched to a visit by phone number, and
   * the visit is what carries the branch. Scoping the upload to the branch in
   * the top bar would have silently dropped every response from the others.
   */
  @Post('import')
  @RateLimit('expensive')
  @UseInterceptors(FileInterceptor('file', NPS_IMPORT_UPLOAD_OPTIONS))
  importSheet(
    @CurrentUser() user: AuthUser,
    @Body() body: NpsImportDto,
    @UploadedFile() file?: { buffer?: Buffer; originalname?: string },
  ) {
    return this.nps.importUpload(user, file, body);
  }

  /**
   * The whole authorised set across three tabs — Updates, Responses, Follow-ups
   * — not the page on screen.
   *
   * `from`/`to` are the Excel dialog's date range, as calendar dates. Both
   * absent is ALL TIME, which is what this did before the dialog existed and
   * what it still does by default — the client downloads the lot today, and
   * making her name two dates first would have made that slower, not better.
   * Which column each sheet is dated by is `exportXlsx`'s business; see there.
   */
  @Get('export')
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async export(
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
    @StoreHeader() storeId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const { buffer, filename, rows } = await this.nps.exportXlsx(user, { storeId, from, to });
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Row-Count', String(rows));
    res.send(buffer);
  }
}
