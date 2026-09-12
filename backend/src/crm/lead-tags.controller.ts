import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';

import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import {
  CreateLeadTagDto,
  ListLeadTagsDto,
  SetLeadTagsDto,
  UpdateLeadTagDto,
} from './dto/lead-tags.dto';
import { LeadTagsService } from './lead-tags.service';

/**
 * Lead tags.
 *
 * Reading the vocabulary and labelling a lead are salesperson-level — the person
 * who spoke to the customer is the one who knows they are worth chasing. Changing
 * what the vocabulary IS is manager-level, because a tag renamed underneath a
 * team changes the meaning of every lead already carrying it.
 */
@Roles('salesperson')
@Controller('lead-tags')
export class LeadTagsController {
  constructor(private readonly tags: LeadTagsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListLeadTagsDto) {
    return this.tags.list(user, query.includeInactive === true);
  }

  @Roles('store_manager')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateLeadTagDto) {
    return this.tags.create(user, dto);
  }

  @Roles('store_manager')
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateLeadTagDto) {
    return this.tags.update(user, id, dto);
  }

  /**
   * Retire, not delete. A tag that has been used is part of the record of what
   * somebody thought at the time.
   */
  @Roles('store_manager')
  @Delete(':id')
  retire(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tags.retire(user, id);
  }

  @Get('lead/:leadId')
  forLead(@CurrentUser() user: AuthUser, @Param('leadId') leadId: string) {
    return this.tags.forLead(user, leadId);
  }

  /** PUT, because the body is the complete set the lead should carry. */
  @Put('lead/:leadId')
  setForLead(
    @CurrentUser() user: AuthUser,
    @Param('leadId') leadId: string,
    @Body() dto: SetLeadTagsDto,
  ) {
    return this.tags.setForLead(user, leadId, dto.tagIds);
  }
}
