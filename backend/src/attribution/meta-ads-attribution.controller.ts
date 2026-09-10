import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { RateLimit } from '../common/rate-limit';
import { MetaAdsInsightsService } from './meta-ads-insights.service';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class MetaAdsSyncDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  integrationId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  adAccountAssetId!: string;

  @Matches(ISO_DATE)
  dateFrom!: string;

  @Matches(ISO_DATE)
  dateTo!: string;
}

export class MetaAdsPerformanceDto extends MetaAdsSyncDto {
  @IsOptional()
  @IsIn(['first_touch', 'last_touch'])
  model?: 'first_touch' | 'last_touch';
}

/** Measured Meta spend and ROAS. No route accepts a token or account id. */
@Controller('attribution/meta-ads')
export class MetaAdsAttributionController {
  constructor(private readonly insights: MetaAdsInsightsService) {}

  /** Queueing can consume a provider rate limit, so only head office may do it. */
  @Roles('head_office')
  @RateLimit('integration')
  @Post('sync')
  sync(@CurrentUser() user: AuthUser, @Body() dto: MetaAdsSyncDto) {
    return this.insights.schedule(user, dto);
  }

  /** Commercially sensitive, tenant/store-scoped performance view. */
  @Roles('store_manager')
  @Get('performance')
  performance(@CurrentUser() user: AuthUser, @Query() query: MetaAdsPerformanceDto) {
    return this.insights.performance(user, query);
  }
}
