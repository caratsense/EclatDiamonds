import { Body, Controller, Get, Post } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/payment.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { Roles } from '../auth/roles.decorator';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.payments.list(user, store);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePaymentDto) {
    return this.payments.create(user, dto);
  }

  /**
   * Bank-vs-till reconciliation exposes where the branch's takings are short.
   * That is a management view, not a counter one.
   */
  @Roles('store_manager', 'area_manager', 'head_office')
  @Get('reconciliation')
  reconciliation(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.payments.reconciliation(user, store);
  }
}
