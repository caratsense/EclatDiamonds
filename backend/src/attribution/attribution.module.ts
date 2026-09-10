import { Module } from '@nestjs/common';

import { MetaAdsAttributionController } from './meta-ads-attribution.controller';
import { MetaAdsInsightsService } from './meta-ads-insights.service';

/**
 * Provider-backed attribution additions. Core declared/measured touch capture
 * remains in CrmModule; this module adds spend ingestion and windowed ROAS.
 */
@Module({
  controllers: [MetaAdsAttributionController],
  providers: [MetaAdsInsightsService],
  exports: [MetaAdsInsightsService],
})
export class AttributionModule {}
