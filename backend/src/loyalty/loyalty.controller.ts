import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { LoyaltyService } from './loyalty.service';
import {
  CreateReferralCodeDto,
  CreateReferralDto,
  EnrollMemberDto,
  ReferralPayoutDto,
} from './dto/loyalty.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { Roles } from '../auth/roles.decorator';

@Controller('loyalty')
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get('plans')
  plans() {
    return this.loyalty.plans();
  }

  @Get('members')
  members(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.loyalty.members(user, store);
  }

  @Post('members')
  enroll(@CurrentUser() user: AuthUser, @Body() dto: EnrollMemberDto) {
    return this.loyalty.enroll(user, dto);
  }

  // --- Module 17: "Earn with Éclat" referral / commission program ---

  @Get('referral-codes')
  referralCodes(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.loyalty.referralCodes(user, store);
  }

  /** Minting codes is a manager+ action; company-wide codes are HO-only (service). */
  @Roles('store_manager', 'area_manager', 'head_office')
  @Post('referral-codes')
  createReferralCode(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateReferralCodeDto,
  ) {
    return this.loyalty.createReferralCode(user, dto);
  }

  @Get('referral-codes/:id/wallet')
  wallet(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @StoreHeader() store?: string,
  ) {
    return this.loyalty.wallet(user, id, store);
  }

  /** Paying out commission moves money — manager+ only (HO-only for company-wide codes). */
  @Roles('store_manager', 'area_manager', 'head_office')
  @Post('referral-codes/:id/payout')
  payout(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReferralPayoutDto,
  ) {
    return this.loyalty.payout(user, id, dto);
  }

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
