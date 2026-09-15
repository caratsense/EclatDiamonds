import { Module } from '@nestjs/common';
import { DiscountsModule } from '../discounts/discounts.module';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';
import { QuoteApprovalService } from './quote-approval.service';

@Module({
  // Discount caps come from Module 15's DiscountLimit, not a copy of them.
  imports: [DiscountsModule],
  controllers: [QuotesController],
  providers: [QuotesService, QuoteApprovalService],
  exports: [QuoteApprovalService],
})
export class QuotesModule {}
