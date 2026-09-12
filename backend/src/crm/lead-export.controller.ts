import { Controller, Get, Header, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';

import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { LeadExportCountDto, LeadExportQueryDto } from './dto/lead-export.dto';
import { LeadExportService, type ExportColumn } from './lead-export.service';

/**
 * Lead export.
 *
 * Manager-level, not salesperson-level. One lead on a screen is the job; a file
 * of every customer's name and phone number is a different act, and the audit
 * trail this writes is only meaningful if the people who can trigger it are the
 * people accountable for the list.
 *
 * Scope is enforced in the service from the caller's token — a `storeId` in the
 * query can narrow the result but never widen it.
 */
@Roles('store_manager')
@Controller('crm/exports')
export class LeadExportController {
  constructor(private readonly exports: LeadExportService) {}

  /**
   * How many rows this filter would produce.
   *
   * The UI calls this before offering the download so a manager sees "12,480
   * leads" and can narrow it, rather than waiting on a file that is then refused
   * for being over the limit.
   */
  @Get('leads/count')
  async count(@CurrentUser() user: AuthUser, @Query() query: LeadExportCountDto) {
    const rows = await this.exports.count(user, {
      ...query,
      columns: query.columns as ExportColumn[] | undefined,
    });
    return { rows };
  }

  @Get('leads.xlsx')
  @Header(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  async leads(
    @CurrentUser() user: AuthUser,
    @Query() query: LeadExportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, filename, rows } = await this.exports.build(user, {
      ...query,
      columns: query.columns as ExportColumn[] | undefined,
    });
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.byteLength));
    // So a caller can assert what it received without opening the workbook.
    res.setHeader('X-Export-Rows', String(rows));
    /*
     * StreamableFile, not a bare Buffer.
     *
     * A Buffer returned from a handler goes through Nest's normal serialiser and
     * arrives as {"type":"Buffer","data":[80,75,...]} — which has the right bytes
     * inside a JSON wrapper, so the download looks plausible and then fails to
     * open. StreamableFile is the escape hatch that writes the bytes themselves.
     */
    return new StreamableFile(buffer);
  }
}
