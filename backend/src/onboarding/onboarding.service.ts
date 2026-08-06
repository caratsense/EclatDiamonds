import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';

/**
 * How many times the welcome guide is allowed to open by itself before it
 * retires for good. Ten passes is enough for the pattern to stick without the
 * guide ever becoming the thing you have to close before you can start work.
 */
export const TOUR_MAX_VIEWS = 10;

export interface TourState {
  /** Times the guide has opened on its own for this account. */
  views: number;
  maxViews: number;
  /** Automatic openings still to come (0 once retired). */
  viewsLeft: number;
  /** True once finished or explicitly turned off — retired early. */
  done: boolean;
  /** The single flag the client acts on: should it open by itself right now? */
  autoOpen: boolean;
}

/**
 * Onboarding — welcome-guide progress, tracked per user ACCOUNT.
 *
 * Deliberately server-side. The shop floor shares tablets, so a browser-local
 * flag meant whoever opened the app first decided for everyone after them, and
 * the same person starting over on their phone. Hanging it off the user row makes
 * "ten times, then it leaves you alone" true per person, on every device.
 */
@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  private toState(views: number, doneAt: Date | null): TourState {
    const seen = Math.min(views, TOUR_MAX_VIEWS);
    const done = doneAt !== null;
    return {
      views: seen,
      maxViews: TOUR_MAX_VIEWS,
      viewsLeft: done ? 0 : TOUR_MAX_VIEWS - seen,
      done,
      autoOpen: !done && seen < TOUR_MAX_VIEWS,
    };
  }

  /** GET /onboarding/tour — where this account stands. */
  async getTour(auth: AuthUser): Promise<TourState> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.id },
      select: { tourViews: true, tourDoneAt: true },
    });
    return this.toState(user.tourViews, user.tourDoneAt);
  }

  /**
   * POST /onboarding/tour/viewed — count one automatic opening.
   *
   * Only the client's auto-open path calls this; reopening the guide by hand
   * from the user menu deliberately does not, so asking for a refresher never
   * costs someone one of their ten.
   *
   * The increment is done by the database rather than read-modify-write, so two
   * tabs opening at once cannot both write the same number back.
   */
  async recordView(auth: AuthUser): Promise<TourState> {
    const user = await this.prisma.user.update({
      where: { id: auth.id },
      data: { tourViews: { increment: 1 } },
      select: { tourViews: true, tourDoneAt: true },
    });
    return this.toState(user.tourViews, user.tourDoneAt);
  }

  /**
   * POST /onboarding/tour/done — retire the guide now.
   *
   * Sent when the user reaches the last step or picks "Don't show this again".
   * Idempotent: the first timestamp wins, so a double-click does not rewrite it.
   */
  async markDone(auth: AuthUser): Promise<TourState> {
    const current = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.id },
      select: { tourViews: true, tourDoneAt: true },
    });
    if (current.tourDoneAt) return this.toState(current.tourViews, current.tourDoneAt);

    const user = await this.prisma.user.update({
      where: { id: auth.id },
      data: { tourDoneAt: new Date() },
      select: { tourViews: true, tourDoneAt: true },
    });
    return this.toState(user.tourViews, user.tourDoneAt);
  }

  /**
   * POST /onboarding/tour/reset — start the guide over for THIS account.
   *
   * Zeroes the view count and clears the "done" flag, so the guide auto-opens
   * again on the next login. Acts only on the caller's own row — good for a
   * refresher, or to preview the guide after editing it.
   */
  async resetTour(auth: AuthUser): Promise<TourState> {
    const user = await this.prisma.user.update({
      where: { id: auth.id },
      data: { tourViews: 0, tourDoneAt: null },
      select: { tourViews: true, tourDoneAt: true },
    });
    return this.toState(user.tourViews, user.tourDoneAt);
  }
}
