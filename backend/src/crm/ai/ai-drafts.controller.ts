import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { AuthUser, CurrentUser } from '../../common/auth-user';
import { HumansOnly } from '../../auth/machine.decorator';
import { AiDraftsService } from './ai-drafts.service';

export class ApproveDraftDto {
  /** Supply to edit before queueing. Omit to queue exactly what was drafted. */
  @IsOptional() @IsString() @MaxLength(4000)
  body?: string;

  @IsOptional() @IsString() @MaxLength(500)
  note?: string;
}

export class RejectDraftDto {
  @IsOptional() @IsString() @MaxLength(500)
  note?: string;
}

/**
 * Review of AI drafts.
 *
 * `@HumansOnly()` is the point of this controller. A machine principal (a
 * Connect agent, a sync token) can reach plenty of this API, and it must never
 * be able to approve a message to a customer — "approval requires a human" has
 * to be enforced by the guard, not by the fact that no machine currently calls
 * it.
 */
@HumansOnly()
@Controller('crm/ai/drafts')
export class AiDraftsController {
  constructor(private readonly drafts: AiDraftsService) {}

  /** `state` is pending (default) | reviewed | all. */
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('conversationId') conversationId?: string,
    @Query('state') state?: string,
  ) {
    return this.drafts.list(user, { conversationId: conversationId || undefined, state });
  }

  /** Queue the draft, optionally after editing it. Never reports it as sent. */
  @Post(':id/approve')
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ApproveDraftDto) {
    return this.drafts.approve(user, id, dto);
  }

  @Post(':id/reject')
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RejectDraftDto) {
    return this.drafts.reject(user, id, dto);
  }
}
