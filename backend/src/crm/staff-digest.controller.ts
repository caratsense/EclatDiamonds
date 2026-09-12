import { Body, Controller, Get, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { StaffDigestService } from './staff-digest.service';

export class StaffDigestSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** 0-23, read in each store's own timezone. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(23)
  sendHourLocal?: number;

  @IsOptional()
  @IsBoolean()
  whatsappEnabled?: boolean;

  /** The name of a template already approved in Meta, not free text to send. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  templateName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  templateLanguage?: string;
}

/**
 * The morning call list.
 *
 * Settings are manager-level — when a tenant's staff get messaged is not a
 * floor decision. The preview is open to any signed-in user, and deliberately
 * shows only THEIR OWN list: it exists so somebody can see what they will
 * receive, not so they can read a colleague's customers.
 */
@Roles('salesperson')
@Controller('staff-digest')
export class StaffDigestController {
  constructor(private readonly digest: StaffDigestService) {}

  /** What my digest would say right now. Sends nothing. */
  @Get('preview')
  preview(@CurrentUser() user: AuthUser) {
    return this.digest.preview(user);
  }

  @Roles('store_manager')
  @Get('settings')
  settings(@CurrentUser() user: AuthUser) {
    return this.digest.settingsFor(user.organisationId);
  }

  @Roles('store_manager')
  @Put('settings')
  save(@CurrentUser() user: AuthUser, @Body() dto: StaffDigestSettingsDto) {
    return this.digest.saveSettings(user, dto);
  }
}
