import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto, ReversePaymentDto } from './dto/payment.dto';
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
   * POST /payments/:id/reverse — reverse a collection with a signed reversal
   * entry (store manager → head office; the original stays immutable). Reason
   * required, store-scoped, at most one reversal per payment.
   */
  @Roles('store_manager', 'head_office')
  @Post(':id/reverse')
  reverse(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReversePaymentDto,
  ) {
    return this.payments.reverse(user, id, dto);
  }

  /**
   * Bank-vs-till reconciliation exposes where the branch's takings are short.
   * That is a management view, not a counter one.
   */
  @Roles('store_manager', 'head_office')
  @Get('reconciliation')
  reconciliation(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.payments.reconciliation(user, store);
  }
}
