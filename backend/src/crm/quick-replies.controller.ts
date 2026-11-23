import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';

import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import {
  CreateQuickReplyDto,
  ReorderQuickRepliesDto,
  UpdateQuickReplyDto,
} from './quick-replies.dto';
import { QuickRepliesService } from './quick-replies.service';

/**
 * Quick replies.
 *
 * The split is the same one lead tags make, and for the same reason. USING a
 * quick reply is front-line work: the salesperson with the customer in front of
 * them taps a chip, and the two routes under `conversation/` are therefore
 * salesperson-level. CHANGING what the chips are is manager work, because a
 * reply reworded underneath a team changes what every one of them says next.
 *
 * Mounted under `crm/` so the entitlement layer treats it as the core CRM it is
 * (`/crm` is capability-free in `config/entitlements.ts`), and soft-mapped to
 * `settings/quick-replies` in `auth/access.ts` so a manager who holds that
 * screen is served at their own level while everybody else falls through to the
 * @Roles below — never refused for not holding a settings screen they have no
 * business opening.
 *
 * The one rule that is NOT here is scope: whether a reply may be written for
 * every branch rather than for one is `QuickRepliesService.assertScope`, where
 * the refusal can name the branch the person does have.
 */
@Roles('salesperson')
@Controller('crm/quick-replies')
export class QuickRepliesController {
  constructor(private readonly quickReplies: QuickRepliesService) {}

  /** The chips for one thread: only what can actually be sent right now. */
  @Get('conversation/:conversationId')
  forConversation(
    @CurrentUser() user: AuthUser,
    @Param('conversationId') conversationId: string,
  ) {
    return this.quickReplies.forConversation(user, conversationId);
  }

  /**
   * Press a template-backed chip. Free text never comes here — it fills the
   * composer and leaves by the send button that was always there.
   */
  @Post('conversation/:conversationId/:id/send')
  send(
    @CurrentUser() user: AuthUser,
    @Param('conversationId') conversationId: string,
    @Param('id') id: string,
  ) {
    return this.quickReplies.send(user, conversationId, id);
  }

  @Roles('store_manager')
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.quickReplies.list(user);
  }

  @Roles('store_manager')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateQuickReplyDto) {
    return this.quickReplies.create(user, dto);
  }

  /** PUT, because the body is the whole order the screen is showing. */
  @Roles('store_manager')
  @Put('order')
  reorder(@CurrentUser() user: AuthUser, @Body() dto: ReorderQuickRepliesDto) {
    return this.quickReplies.reorder(user, dto.ids);
  }

  @Roles('store_manager')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateQuickReplyDto,
  ) {
    return this.quickReplies.update(user, id, dto);
  }

  @Roles('store_manager')
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.quickReplies.remove(user, id);
  }
}
