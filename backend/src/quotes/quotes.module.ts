import { Module } from '@nestjs/common';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';
import { QuoteApprovalService } from './quote-approval.service';

@Module({
  controllers: [QuotesController],
  providers: [QuotesService, QuoteApprovalService],
  exports: [QuoteApprovalService],
})
export class QuotesModule {}
