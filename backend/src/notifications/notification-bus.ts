import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Observable, Subject, filter, map } from 'rxjs';

/**
 * The payload pushed down an open SSE connection. Deliberately the same shape
 * the REST feed returns, so the client renders a pushed item and a fetched item
 * with one code path.
 */
export interface NotificationEvent {
  id: string;
  userId: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  priority: string;
  storeId: string | null;
  entityType: string | null;
  entityId: string | null;
  actorName: string | null;
  createdAt: string;
  /** Recipient's unread count AFTER this event — saves the client a round trip. */
  unreadCount: number;
}

/**
 * NotificationBus — fan-out between the process that WRITES a notification and
 * the connections waiting to receive it.
 *
 * ## Why this is an interface and not just an rxjs Subject
 *
 * Delivery is instant because of SSE, not because of any particular bus. A bus
 * only starts mattering when the API runs on more than one instance: the write
 * can land on instance A while the recipient's connection is held by instance B,
 * and an in-process Subject cannot cross that gap.
 *
 * Eclat runs a single Railway service today, so {@link InMemoryNotificationBus}
 * is correct and costs nothing. When the service is scaled out, implement this
 * same two-method contract over Redis pub/sub (publish → `PUBLISH notif:<userId>`,
 * subscribe → a subscriber client per instance) and swap the provider in
 * `notifications.module.ts`. Nothing else in the codebase changes, because
 * nothing else touches the bus directly.
 */
export abstract class NotificationBus {
  /** Deliver an event to whichever connections that user currently holds. */
  abstract publish(event: NotificationEvent): void;

  /** A stream of the events addressed to one user. */
  abstract subscribe(userId: string): Observable<NotificationEvent>;
}

/**
 * Single-instance bus backed by an rxjs Subject.
 *
 * One Subject for every user (rather than one per connection) keeps the
 * bookkeeping trivial: a user with the app open in three tabs simply gets three
 * subscribers on the same stream. Events are NOT buffered — a user with no open
 * connection misses the push and picks the notification up from the REST feed on
 * their next load, which is exactly why the row is persisted first.
 */
@Injectable()
export class InMemoryNotificationBus extends NotificationBus implements OnModuleDestroy {
  private readonly logger = new Logger(InMemoryNotificationBus.name);
  private readonly stream = new Subject<NotificationEvent>();

  publish(event: NotificationEvent): void {
    this.stream.next(event);
  }

  subscribe(userId: string): Observable<NotificationEvent> {
    return this.stream.asObservable().pipe(
      filter((e) => e.userId === userId),
      map((e) => e),
    );
  }

  onModuleDestroy(): void {
    // Complete the stream so every open SSE response is closed cleanly on
    // shutdown rather than being cut mid-frame.
    this.logger.log('Closing notification stream');
    this.stream.complete();
  }
}
