import { Body, Controller, Get, Header, Param, Patch, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { CheckinsService } from './checkins.service';
import { CheckinSettingsDto, CheckoutDto, CreateCheckInDto } from './dto/checkin.dto';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, AuthUser } from '../common/auth-user';
import {
  describeExportRange,
  inclusiveTo,
  rangeFilename,
  resolveExportRange,
} from '../common/export-range';
import { StoreHeader } from '../common/store-header.decorator';

@Controller('checkins')
export class CheckinsController {
  constructor(private readonly checkins: CheckinsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.checkins.list(user, store);
  }

  /**
   * The walk-in log as Excel, survey columns included. Same scope as the list.
   *
   * `from`/`to` are the Excel dialog's range, and they filter on `timeIn` — the
   * day the customer actually walked in. Not `createdAt`: a visit logged the
   * morning after a late closing is still yesterday's footfall, and the register
   * is the one sheet head office reconciles against the branch's own day book.
   *
   * Both absent is all time, which is what this did before the dialog existed.
   */
  @Get('export.xlsx')
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async exportXlsx(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
    @StoreHeader() store?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const range = resolveExportRange(from, to);
    const { buffer, rows } = await this.checkins.exportXlsx(user, store, {
      from: range.from,
      // `exportXlsx` compares with `lte`; see `inclusiveTo`.
      to: inclusiveTo(range),
      label: describeExportRange(from, to),
    });
    const filename = from || to ? rangeFilename('walk-ins', from, to) : 'walk-ins.xlsx';
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Rows', String(rows));
    return new StreamableFile(buffer);
  }

  /**
   * Whether the screen shows who is in the store now. A shop that logs the
   * visit after serving the customer has no live count to show (client,
   * 9 Oct), so head office can switch it off for the organisation.
   */
  @Roles('head_office')
  @Put('settings')
  saveSettings(@CurrentUser() user: AuthUser, @Body() dto: CheckinSettingsDto) {
    return this.checkins.saveSettings(user, dto);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCheckInDto) {
    return this.checkins.create(user, dto);
  }

  @Patch(':id')
  checkout(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CheckoutDto,
    @StoreHeader() store?: string,
  ) {
    return this.checkins.checkout(user, id, store, dto);
  }
}
