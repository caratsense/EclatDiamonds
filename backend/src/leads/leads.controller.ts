import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { LeadsService } from './leads.service';
import {
  CreateLeadDto,
  ListLeadsQuery,
  ReminderQuery,
  UpdateFollowUpDto,
  UpdateLeadDto,
} from './dto/lead.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';

@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() q: ListLeadsQuery,
    @StoreHeader() store?: string,
  ) {
    return this.leads.list(user, q, store);
  }

  // NOTE: reminder routes MUST stay above `@Get(':id')` so `/leads/reminders`
  // is not swallowed by the `:id` param route.
  @Get('reminders')
  reminders(
    @CurrentUser() user: AuthUser,
    @Query() q: ReminderQuery,
    @StoreHeader() store?: string,
  ) {
    return this.leads.reminders(user, q, store);
  }

  @Patch('reminders/:id')
  updateFollowUp(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateFollowUpDto,
  ) {
    return this.leads.updateFollowUp(user, id, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.leads.get(user, id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateLeadDto) {
    return this.leads.create(user, dto);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateLeadDto) {
    return this.leads.update(user, id, dto);
  }
}
