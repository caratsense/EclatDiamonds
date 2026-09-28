import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { DiscountsModule } from '../discounts/discounts.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';

/**
 * Sales (Direct Sales) format + Module 12 payment capture folded in.
 * Additive to the legacy-synced sales and the existing payments module.
 * Imports DiscountsModule to reuse the Module 15 cap enforcement on sale discounts,
 * and LoyaltyModule so a counter sale earns points on the same ledger the website uses.
 */
@Module({
  imports: [DiscountsModule, LoyaltyModule],
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
