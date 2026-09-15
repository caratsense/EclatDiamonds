import { Body, Controller, Get, Post } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { AssistantService } from './assistant.service';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { AskDto } from './dto/assistant.dto';

/**
 * The in-app assistant.
 *
 * Every answer is a store-scoped, role-filtered query over data the caller could
 * already reach by navigating — a faster route to their own information, never a
 * wider one.
 */
// Answers from branch-wide data; store manager and above.
@Roles('store_manager')
@Controller('assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  /** GET /assistant/suggestions — the opening chips, filtered by role. */
  @Get('suggestions')
  suggestions(@CurrentUser() user: AuthUser) {
    return { suggestions: this.assistant.suggestionsFor(user) };
  }

  /** POST /assistant/ask — answer one question. */
  @Post('ask')
  ask(
    @CurrentUser() user: AuthUser,
    @Body() dto: AskDto,
    @StoreHeader() store?: string,
  ) {
    return this.assistant.ask(user, dto, store);
  }
}
