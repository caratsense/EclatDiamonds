import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../auth/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { FeedbackService } from './feedback.service';
import {
  FeedbackSettingsDto,
  FeedbackSummaryDto,
  ListFeedbackDto,
  RequestFeedbackDto,
  RespondFeedbackDto,
} from './dto/feedback.dto';

/**
 * Feedback, for the team.
 *
 * Salesperson-level for asking — the person who served the customer is the one
 * who knows the visit is over — and manager-level for the settings that decide
 * when a customer is offered a public review link.
 */
@Roles('salesperson')
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Get('summary')
  summary(@CurrentUser() user: AuthUser, @Query() query: FeedbackSummaryDto) {
    return this.feedback.summary(user, query);
  }

  @Get('responses')
  list(@CurrentUser() user: AuthUser, @Query() query: ListFeedbackDto) {
    return this.feedback.list(user, query);
  }

  @Get('settings')
  settings(@CurrentUser() user: AuthUser) {
    return this.feedback.settings(user);
  }

  /** Manager-level is re-checked in the service; this is the floor, not the authority. */
  @Patch('settings')
  updateSettings(@CurrentUser() user: AuthUser, @Body() body: FeedbackSettingsDto) {
    return this.feedback.updateSettings(user, body);
  }

  @Post('requests')
  request(@CurrentUser() user: AuthUser, @Body() body: RequestFeedbackDto) {
    return this.feedback.request(user, body);
  }
}

/**
 * The customer's side. Anonymous, like the QR capture and the website enquiry
 * form, and public for the same reason: a customer answering a survey has no
 * account and must not be asked to make one.
 *
 * Throttled per IP. The key is unguessable, but a throttle is what stops someone
 * who obtains one from hammering it, and what stops key enumeration being cheap.
 */
@Public()
@Controller('public/feedback')
export class PublicFeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':publicKey')
  view(@Param('publicKey') publicKey: string) {
    return this.feedback.publicView(publicKey);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':publicKey')
  respond(@Param('publicKey') publicKey: string, @Body() body: RespondFeedbackDto) {
    return this.feedback.respond(publicKey, body);
  }
}
