import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { DiscountsModule } from '../discounts/discounts.module';

/**
 * Sales (Direct Sales) format + Module 12 payment capture folded in.
 * Additive to the legacy-synced sales and the existing payments module.
 * Imports DiscountsModule to reuse the Module 15 cap enforcement on sale discounts.
 */
@Module({
  imports: [DiscountsModule],
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
