import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ReturnsService } from './returns.service';
import {
  CreateDiamondRateDto,
  CreateReturnDto,
  DecideReturnDto,
  ValuateReturnDto,
} from './dto/return.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { Roles } from '../auth/roles.decorator';

@Controller('returns')
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.returns.list(user, store);
  }

  /** Current gold (per karat/gram) + diamond (per spec) rates for the calculator UI. */
  @Get('rates')
  rates(@StoreHeader() store?: string) {
    return this.returns.rates(store);
  }

  /** HO-managed diamond-rate table (list). */
  @Get('diamond-rates')
  diamondRates(@StoreHeader() store?: string) {
    return this.returns.diamondRates(store);
  }

  /** HO sets/updates a diamond rate for a spec/code. */
  @Roles('head_office')
  @Post('diamond-rates')
  createDiamondRate(@Body() dto: CreateDiamondRateDto) {
    return this.returns.createDiamondRate(dto);
  }

  /** Preview the exchange/buyback values without persisting. */
  @Post('valuate')
  valuate(@CurrentUser() user: AuthUser, @Body() dto: ValuateReturnDto) {
    return this.returns.valuate(user, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.returns.get(user, id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateReturnDto) {
    return this.returns.create(user, dto);
  }

  /** HO approval to process the exchange/return. */
  @Roles('head_office')
  @Patch(':id/approve')
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DecideReturnDto) {
    return this.returns.approve(user, id, dto?.note);
  }

  @Roles('head_office')
  @Patch(':id/reject')
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DecideReturnDto) {
    return this.returns.reject(user, id, dto?.note);
  }
}
