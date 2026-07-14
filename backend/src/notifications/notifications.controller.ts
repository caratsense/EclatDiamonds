import { Controller, Get } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** GET /notifications/summary — actionable counts for the current user/store. */
  @Get('summary')
  summary(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.notifications.summary(user, store);
  }
}
