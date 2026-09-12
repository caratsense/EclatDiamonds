import { Module } from '@nestjs/common';
import { LoyaltyController } from './loyalty.controller';
import { LoyaltyService } from './loyalty.service';
import {
  LoyaltyProgrammeController,
  PublicLoyaltyController,
} from './website/loyalty-api.controller';
import { LoyaltyApiService } from './website/loyalty-api.service';

@Module({
  controllers: [LoyaltyController, LoyaltyProgrammeController, PublicLoyaltyController],
  providers: [LoyaltyService, LoyaltyApiService],
  // The scheduler sweeps unannounced ledger movements.
  exports: [LoyaltyApiService],
})
export class LoyaltyModule {}
