import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { CommissionsService } from './commissions.service';
import { UpsertCommissionPlanDto } from './dto/commission-plan.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { Roles } from '../auth/roles.decorator';

/**
 * Store-level sales commission (client 9 Oct item 13). Plan configuration
 * (threshold + rate per store) is HEAD OFFICE only, like other HO-set numbers
 * (discount limits, week-off); the monthly summary is store_manager+ and
 * store-scoped. Strictly separate from the per-staff /hrms/commission rates
 * and from the Module 17 customer referral credit.
 */
@Controller('commissions')
export class CommissionsController {
  constructor(private readonly commissions: CommissionsService) {}

  /** GET /commissions/plans — every configured store plan (head office). */
  @Roles('head_office')
  @Get('plans')
  listPlans(@CurrentUser() user: AuthUser) {
    return this.commissions.listPlans(user);
  }

  /** PUT /commissions/plans — set/replace a store's plan (head office). */
  @Roles('head_office')
  @Put('plans')
  upsertPlan(@CurrentUser() user: AuthUser, @Body() dto: UpsertCommissionPlanDto) {
    return this.commissions.upsertPlan(user, dto);
  }

  /** GET /commissions/summary?month=YYYY-MM&storeId= — commission breakdown per store in scope. */
  @Roles('store_manager')
  @Get('summary')
  summary(
    @CurrentUser() user: AuthUser,
    @Query('month') month?: string,
    @StoreHeader() store?: string,
  ) {
    return this.commissions.summary(user, month, store);
  }
}
