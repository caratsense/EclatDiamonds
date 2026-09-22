import { Module } from '@nestjs/common';
import { DiscountsModule } from '../discounts/discounts.module';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';
import { QuoteApprovalService } from './quote-approval.service';
import { MaterialsController } from './materials.controller';
import { MaterialsService } from './materials.service';

@Module({
  // Discount caps come from Module 15's DiscountLimit, not a copy of them.
  imports: [DiscountsModule],
  controllers: [QuotesController, MaterialsController],
  providers: [QuotesService, QuoteApprovalService, MaterialsService],
  exports: [QuoteApprovalService],
})
export class QuotesModule {}
