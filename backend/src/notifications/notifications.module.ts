import { Global, Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { InMemoryNotificationBus, NotificationBus } from './notification-bus';

/**
 * Notifications — persisted feed + live SSE push.
 *
 * `@Global` because almost every module has some event worth telling someone
 * about (an approval raised, a decision made, an order stalling), and threading
 * an import through each of them adds noise for no benefit.
 *
 * ## Swapping in Redis
 *
 * The bus provider below is the ONLY place that decides how a published event
 * reaches an open connection. To scale the API past one instance, write a
 * `RedisNotificationBus` implementing the same two-method `NotificationBus`
 * contract (publish → `PUBLISH notif:<userId>`; subscribe → a shared subscriber
 * client filtered per user) and change `useClass` here. No service, controller
 * or client code changes, because nothing else touches the bus.
 */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    { provide: NotificationBus, useClass: InMemoryNotificationBus },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
