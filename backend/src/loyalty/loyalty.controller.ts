import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { LoyaltyService } from './loyalty.service';
import {
  CreateReferralCodeDto,
  CreateReferralDto,
  CreateSchemePlanDto,
  EnrollMemberDto,
  ReferralPayoutDto,
  UpdateSchemePlanDto,
} from './dto/loyalty.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { Roles } from '../auth/roles.decorator';

@Controller('loyalty')
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  /**
   * Scheme plans. Enrollment sees only active plans; the Head Office management
   * screen passes ?includeInactive=true to also see retired ones.
   */
  @Get('plans')
  plans(@CurrentUser() user: AuthUser, @Query('includeInactive') includeInactive?: string) {
    return this.loyalty.plans(user, includeInactive === 'true');
  }

  // --- Scheme plan management (Head Office defines the client's own scheme) ---

  @Roles('head_office')
  @Post('plans')
  createPlan(@CurrentUser() user: AuthUser, @Body() dto: CreateSchemePlanDto) {
    return this.loyalty.createPlan(user, dto);
  }

  @Roles('head_office')
  @Patch('plans/:id')
  updatePlan(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateSchemePlanDto,
  ) {
    return this.loyalty.updatePlan(user, id, dto);
  }

  @Roles('head_office')
  @Delete('plans/:id')
  deletePlan(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.loyalty.deletePlan(user, id);
  }

  // Management information: store manager and above, never a salesperson.
  @Roles('store_manager')
  @Get('members')
  members(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.loyalty.members(user, store);
  }

  @Post('members')
  enroll(@CurrentUser() user: AuthUser, @Body() dto: EnrollMemberDto) {
    return this.loyalty.enroll(user, dto);
  }

  // --- Module 17: "Earn with Éclat" referral / commission program ---

  // Management information: store manager and above, never a salesperson.
  @Roles('store_manager')
  @Get('referral-codes')
  referralCodes(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.loyalty.referralCodes(user, store);
  }

  /** Minting codes is a manager+ action; company-wide codes are HO-only (service). */
  @Roles('store_manager', 'head_office')
  @Post('referral-codes')
  createReferralCode(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateReferralCodeDto,
  ) {
    return this.loyalty.createReferralCode(user, dto);
  }

  // Management information: store manager and above, never a salesperson.
  @Roles('store_manager')
  @Get('referral-codes/:id/wallet')
  wallet(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @StoreHeader() store?: string,
  ) {
    return this.loyalty.wallet(user, id, store);
  }

  /** Paying out commission moves money — manager+ only (HO-only for company-wide codes). */
  @Roles('store_manager', 'head_office')
  @Post('referral-codes/:id/payout')
  payout(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReferralPayoutDto,
  ) {
    return this.loyalty.payout(user, id, dto);
  }

  // Management information: store manager and above, never a salesperson.
  @Roles('store_manager')
  @Get('referrals')
  referrals(
    @CurrentUser() user: AuthUser,
    @Query('codeId') codeId?: string,
    @StoreHeader() store?: string,
  ) {
    return this.loyalty.referrals(user, codeId, store);
  }

  @Post('referrals')
  createReferral(@CurrentUser() user: AuthUser, @Body() dto: CreateReferralDto) {
    return this.loyalty.createReferral(user, dto);
  }
}
