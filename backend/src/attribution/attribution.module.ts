import { Module } from '@nestjs/common';

import { AdEnquiryCountsService } from './ad-enquiry-counts.service';
import { MetaAdsAttributionController } from './meta-ads-attribution.controller';
import { MetaAdsInsightsService } from './meta-ads-insights.service';

/**
 * Provider-backed attribution additions. Core declared/measured touch capture
 * remains in CrmModule; this module adds spend ingestion, windowed ROAS, and
 * the enquiry count per advert the client asked for on 28 Nov.
 *
 * `AdEnquiryCountsService` needs no imports here: StoreScopeService comes from
 * the @Global CommonModule and MetaAdMetadataService from the @Global
 * IntegrationsModule, which already exports it for exactly this reuse.
 */
@Module({
  controllers: [MetaAdsAttributionController],
  providers: [MetaAdsInsightsService, AdEnquiryCountsService],
  exports: [MetaAdsInsightsService],
})
export class AttributionModule {}
