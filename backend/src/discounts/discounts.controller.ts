import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { DiscountsService } from './discounts.service';
import {
  CreateDiscountRequestDto,
  DecideDiscountDto,
  SetDiscountLimitDto,
} from './dto/discount.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { Roles } from '../auth/roles.decorator';

@Controller('discounts')
export class DiscountsController {
  constructor(private readonly discounts: DiscountsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.discounts.list(user, store);
  }

  @Get('presets')
  presets() {
    return this.discounts.listPresets();
  }

  /** Configured per-role caps (area_manager / head_office only). */
  @Roles('area_manager')
  @Get('limits')
  limits() {
    return this.discounts.listLimits();
  }

  /** head_office: set/override a global or store-scoped role cap. */
  @Roles('head_office')
  @Post('limits')
  setLimit(@CurrentUser() user: AuthUser, @Body() dto: SetDiscountLimitDto) {
    return this.discounts.setLimit(user, dto);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDiscountRequestDto) {
    return this.discounts.create(user, dto);
  }

  /** Approve — only a role ranked >= the request's requiredRole may act (403 otherwise). */
  @Patch(':id/approve')
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DecideDiscountDto) {
    return this.discounts.approve(user, id, dto?.reason, dto?.note);
  }

  /** Reject — only a role ranked >= the request's requiredRole may act (403 otherwise). */
  @Patch(':id/reject')
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DecideDiscountDto) {
    return this.discounts.reject(user, id, dto?.reason, dto?.note);
  }
}
