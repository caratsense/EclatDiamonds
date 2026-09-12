import { Controller, Get, Query, Res, StreamableFile } from '@nestjs/common';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import * as ExcelJS from 'exceljs';
import type { Response } from 'express';

import { HumansOnly } from '../auth/machine.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { RateLimit } from '../common/rate-limit';
import { ManagementService } from './management.service';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export class KpiQueryDto {
  @IsOptional()
  @Matches(YMD, { message: 'from must be yyyy-mm-dd' })
  from?: string;

  @IsOptional()
  @Matches(YMD, { message: 'to must be yyyy-mm-dd' })
  to?: string;

  @IsOptional()
  @IsString()
  storeId?: string;

  @IsOptional()
  @IsString()
  ownerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  channel?: string;

  @IsOptional()
  @IsString()
  campaignId?: string;

  @IsOptional()
  @IsString()
  tagId?: string;

  /**
   * Which clock the day boundaries are read in.
   *
   * Optional, and when it is omitted across branches in different timezones the
   * response says which one was used and that the branches disagreed. A silent
   * choice would produce a figure that is right for one branch and wrong for the
   * others with nothing on the screen to indicate it.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}

/**
 * The management view: what happened, across the whole business, over a window.
 *
 * ## Why it is not part of `/dashboard`
 *
 * `/dashboard` answers "what is happening in my branch right now" — today's
 * takings, who is on the floor, what is waiting. This answers "how did we do,
 * and where is it going wrong", over a range, with filters, across branches.
 * Different question, different scope, different audience, and a different
 * capability — so a tenant can buy one without the other.
 *
 * ## Scope is enforced here, not hidden in the UI
 *
 * A salesperson may open this and sees their own work: the service overrides the
 * owner filter with their own id rather than trusting the query string. A
 * dashboard is a read of the whole database with a filter on it, which makes it
 * the easiest screen in any product to leak a colleague's pipeline from.
 */
@HumansOnly()
// The aggregates are real work across several tables. Metered as expensive so a
// dashboard left open on a wallboard cannot consume the tenant's whole
// allowance, and so one person refreshing cannot slow the shop floor down.
@RateLimit('expensive')
@Controller('management')
export class ManagementController {
  constructor(private readonly management: ManagementService) {}

  @Get('kpis')
  kpis(@CurrentUser() user: AuthUser, @Query() query: KpiQueryDto) {
    return this.management.kpis(user, query);
  }

  /**
   * The rows behind the lead figures, as a spreadsheet.
   *
   * Returned as a StreamableFile: Nest serialises a bare Buffer as
   * `{"type":"Buffer","data":[...]}`, which downloads as a corrupt workbook and
   * looks like an Excel problem rather than a serialisation one.
   */
  @Get('export/leads')
  async exportLeads(
    @CurrentUser() user: AuthUser,
    @Query() query: KpiQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { window, rows } = await this.management.exportLeads(user, query);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Leads');
    sheet.columns = [
      { header: 'Reference', key: 'ref', width: 16 },
      { header: 'Customer', key: 'customerName', width: 28 },
      { header: 'Phone', key: 'phone', width: 16 },
      { header: 'Source', key: 'source', width: 16 },
      { header: 'Stage', key: 'stage', width: 16 },
      { header: 'Outcome', key: 'outcome', width: 12 },
      { header: 'Value', key: 'value', width: 14 },
      { header: 'Branch', key: 'storeName', width: 20 },
      { header: 'Owner', key: 'ownerId', width: 24 },
      { header: 'Created', key: 'createdAt', width: 22 },
      { header: 'Closed', key: 'closedAt', width: 22 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const row of rows) sheet.addRow(row);

    // Stated in the file itself. A spreadsheet outlives the screen it came from,
    // and a reader six months later has no other way to know which clock decided
    // where one day ended and the next began.
    const notes = workbook.addWorksheet('About');
    notes.addRow(['Window', `${window.fromDate} to ${window.toDate} (inclusive)`]);
    notes.addRow(['Timezone', window.timezone]);
    notes.addRow(['Timezone chosen by', window.resolvedBy]);
    if (window.ambiguous) {
      notes.addRow([
        'Note',
        `Branches in this export span ${window.zonesInScope.join(', ')}. ` +
          `Day boundaries were read in ${window.timezone}.`,
      ]);
    }
    notes.addRow(['Excludes', 'Archived customers']);
    notes.getColumn(1).font = { bold: true };
    notes.getColumn(1).width = 22;
    notes.getColumn(2).width = 80;

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="leads-${window.fromDate}-to-${window.toDate}.xlsx"`,
    });
    return new StreamableFile(buffer);
  }
}
