import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

import { HumansOnly } from '../auth/machine.decorator';
import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { ScheduledReportsService } from './scheduled-reports.service';

export class UpsertScheduledReportDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsIn(['leads'])
  kind?: string;

  /** Null or absent = every branch the report's reader can see. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  storeId?: string | null;

  @IsOptional()
  @IsIn(['monthly', 'weekly'])
  cadence?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(23)
  sendHour?: number;

  /** Empty = every column. The configurable mapping. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(32)
  columns?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  recipients?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class PatchScheduledReportDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  storeId?: string | null;

  @IsOptional()
  @IsIn(['monthly', 'weekly'])
  cadence?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(23)
  sendHour?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(32)
  columns?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  recipients?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Reports that arrive without anybody asking for them.
 *
 * Manager-level, like the manual export it reuses: a recurring file of every
 * customer's name and phone number going to an email address is a different act
 * from reading one lead on a screen, and the audit trail is only meaningful if
 * the people who can set it up are the people accountable for it.
 *
 * Covered by the `/reporting` entitlement entry.
 */
@HumansOnly()
@Roles('store_manager')
@Controller('reporting/scheduled')
export class ScheduledReportsController {
  constructor(private readonly reports: ScheduledReportsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.reports.list(user);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: UpsertScheduledReportDto) {
    return this.reports.create(user, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: PatchScheduledReportDto,
  ) {
    return this.reports.update(user, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.reports.remove(user, id);
  }

  @Get(':id/runs')
  runs(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.reports.runs(user, id, limit ? Number(limit) : undefined);
  }

  /**
   * Send the last completed period now.
   *
   * Idempotent on the period, not on the button: pressing it twice for the same
   * month delivers one email. That is what makes a "did it go?" click safe.
   */
  @Post(':id/run')
  run(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.reports.runNow(user, id);
  }

  /** The same workbook, in the browser, scoped to the caller rather than emailed. */
  @Get(':id/download.xlsx')
  @Header(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  async download(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, filename, rows } = await this.reports.download(user, id);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.byteLength));
    res.setHeader('X-Export-Rows', String(rows));
    // StreamableFile, not a bare Buffer: a Buffer goes through Nest's
    // serialiser and arrives as {"type":"Buffer","data":[...]} — the right bytes
    // in a JSON wrapper, so the download looks plausible and will not open.
    return new StreamableFile(buffer);
  }
}
