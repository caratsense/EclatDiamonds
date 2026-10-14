import { Module } from '@nestjs/common';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';
import { QuoteApprovalService } from './quote-approval.service';
import { MaterialsController } from './materials.controller';
import { MaterialsService } from './materials.service';

@Module({
  controllers: [QuotesController, MaterialsController],
  providers: [QuotesService, QuoteApprovalService, MaterialsService],
  exports: [QuoteApprovalService],
})
export class QuotesModule {}
