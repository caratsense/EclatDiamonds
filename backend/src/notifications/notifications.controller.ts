import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import { Permit } from '../auth/permissions';
import { SkipThrottle } from '@nestjs/throttler';
import { Observable, interval, map, merge } from 'rxjs';
import { NotificationsService } from './notifications.service';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import {
  DismissAllQueryDto,
  FeedQueryDto,
  MarkReadDto,
} from './dto/notifications.dto';

/** One frame on the SSE wire. */
interface StreamMessage {
  type: string;
  data: unknown;
}

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** GET /notifications/summary — actionable counts for the current user/store. */
  @Permit('session')
  @Get('summary')
  summary(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.notifications.summary(user, store);
  }

  /**
   * GET /notifications/stream — live push over Server-Sent Events.
   *
   * Delivery is instant here rather than on the old 60-second poll. Two details
   * make it hold up in production:
   *
   *  - **Heartbeat.** A 25s keep-alive frame stops Railway's edge proxy (and any
   *    corporate proxy in between) from reaping a connection it reads as idle.
   *    Without it the stream dies quietly after a minute or so of no traffic and
   *    the client never learns it has gone deaf.
   *  - **Throttle exemption.** These connections are long-lived by design, so
   *    they must not count against the global 300-req/60s per-IP limit.
   *
   * Auth is the normal `Authorization: Bearer` header — the client streams via
   * `fetch` rather than `EventSource` precisely so the token never travels in a
   * query string, where it would land in proxy and platform logs.
   *
   * Declared before the `:id` routes so it is not shadowed by them.
   */
  @SkipThrottle()
  @Sse('stream')
  stream(@CurrentUser() user: AuthUser): Observable<StreamMessage> {
    const events = this.notifications
      .stream(user.id)
      .pipe(map((e) => ({ type: 'notification', data: e })));

    const heartbeat = interval(25_000).pipe(
      map(() => ({ type: 'ping', data: { at: new Date().toISOString() } })),
    );

    return merge(events, heartbeat);
  }

  /** GET /notifications — the caller's own feed (newest first). */
  @Permit('session')
  @Get()
  feed(@CurrentUser() user: AuthUser, @Query() query: FeedQueryDto) {
    return this.notifications.feed(user, query);
  }

  /** POST /notifications/read-all — mark every unread notification read. */
  @Permit('session')
  @Post('read-all')
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user);
  }

  /** PATCH /notifications/:id/read — mark one read (or back to unread). */
  @Permit('session')
  @Patch(':id/read')
  markRead(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: MarkReadDto,
  ) {
    return this.notifications.markRead(user, id, dto?.read ?? true);
  }

  /**
   * DELETE /notifications — clear the bell.
   *
   * Pass `?onlyRead=true` to clear just what has been seen. Cleared rows are
   * soft-dismissed, not deleted, so the history view can still show them.
   */
  @Permit('session')
  @Delete()
  dismissAll(@CurrentUser() user: AuthUser, @Query() query: DismissAllQueryDto) {
    return this.notifications.dismissAll(user, query?.onlyRead ?? false);
  }

  /** DELETE /notifications/:id — clear one notification. */
  @Permit('session')
  @Delete(':id')
  dismiss(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.notifications.dismiss(user, id);
  }
}
