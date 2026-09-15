import { Controller, Get, Post } from '@nestjs/common';
import { Permit } from '../auth/permissions';

import { OnboardingService } from './onboarding.service';
import { CurrentUser, AuthUser } from '../common/auth-user';

/**
 * Welcome-guide progress for the signed-in account. Every route acts on the
 * caller's own user row only — there is no id parameter to point elsewhere, so
 * nobody can read or reset anyone else's progress. No @Roles gate: this is
 * personal UI state that every role has.
 */
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Permit('session')
  @Get('tour')
  getTour(@CurrentUser() user: AuthUser) {
    return this.onboarding.getTour(user);
  }

  /** Count one automatic opening against this account's ten. */
  @Permit('session')
  @Post('tour/viewed')
  recordView(@CurrentUser() user: AuthUser) {
    return this.onboarding.recordView(user);
  }

  /** Finished, or "don't show this again" — retire it now. */
  @Permit('session')
  @Post('tour/done')
  markDone(@CurrentUser() user: AuthUser) {
    return this.onboarding.markDone(user);
  }

  /** Start the guide over — it auto-opens again on next login. */
  @Permit('session')
  @Post('tour/reset')
  reset(@CurrentUser() user: AuthUser) {
    return this.onboarding.resetTour(user);
  }
}
