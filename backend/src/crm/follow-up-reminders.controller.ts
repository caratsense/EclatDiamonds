import { Body, Controller, Get, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { FollowUpRemindersService } from './follow-up-reminders.service';

export class FollowUpReminderSettingsDto {
  /** Local "HH:MM" a reminder fires when nobody picked a time. */
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'defaultTimeLocal must be HH:MM.' })
  defaultTimeLocal?: string;

  /** Days before the follow-up date. 0 = on the day. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(14)
  defaultDaysBefore?: number;
}

/**
 * The tenant's default for a follow-up reminder nobody timed by hand. Anyone
 * booking a follow-up can read it (the counter shows "you'll be reminded at
 * 10:00"); changing it for the whole team is a manager's decision.
 */
@Roles('salesperson')
@Controller('crm/follow-up-reminders')
export class FollowUpRemindersController {
  constructor(private readonly reminders: FollowUpRemindersService) {}

  @Get('settings')
  settings(@CurrentUser() user: AuthUser) {
    return this.reminders.settings(user.organisationId);
  }

  @Roles('store_manager')
  @Put('settings')
  save(@CurrentUser() user: AuthUser, @Body() dto: FollowUpReminderSettingsDto) {
    return this.reminders.saveSettings(user, dto);
  }
}
