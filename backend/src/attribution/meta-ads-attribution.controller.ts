import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { RateLimit } from '../common/rate-limit';
import { StoreHeader } from '../common/store-header.decorator';
import { AdEnquiryCountsService } from './ad-enquiry-counts.service';
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

export class AdEnquiryCountsDto {
  @IsOptional() @IsString() @Length(1, 40) storeId?: string;

  /** `@Type` is required: a query parameter arrives as a string and `@IsInt()` rejects "90". */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) days?: number;
}

/** Measured Meta spend and ROAS. No route accepts a token or account id. */
@Controller('attribution/meta-ads')
export class MetaAdsAttributionController {
  constructor(
    private readonly insights: MetaAdsInsightsService,
    private readonly enquiryCounts: AdEnquiryCountsService,
  ) {}

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

  /**
   * Which advert brought the most enquiries (client, 28 Nov). Counted from our
   * own threads, so it needs no Meta connection and no ad account — a tenant
   * whose token has expired still gets the counts, named by advert id.
   *
   * Branch from the store switcher unless the caller named one, as every other
   * reporting screen reads it.
   */
  @Roles('store_manager')
  @Get('enquiries')
  enquiries(
    @CurrentUser() user: AuthUser,
    @Query() query: AdEnquiryCountsDto,
    @StoreHeader() store?: string,
  ) {
    return this.enquiryCounts.report(user, { ...query, storeId: query.storeId ?? store });
  }
}
