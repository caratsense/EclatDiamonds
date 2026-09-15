import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

import { AuthUser, CurrentUser } from '../common/auth-user';
import { OmnichannelKpiService } from './omnichannel-kpi.service';

export class OmnichannelSummaryDto {
  @IsOptional() @IsString() @Length(1, 40) storeId?: string;

  /** `@Type` is required: a query parameter arrives as a string and `@IsInt()` rejects "90". */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(730) days?: number;
}

/**
 * Omnichannel headline numbers.
 *
 * Readable by any signed-in user. A salesperson seeing how many people came in
 * this month is ordinary; the figures are already narrowed to the branches that
 * person can see, so there is nothing here they could not count by hand from
 * their own screens.
 *
 * Mounted under `/crm`, which is a universal route family — a clinic and a mill
 * get these numbers without claiming a jewellery capability.
 */
@Controller('crm/omnichannel')
export class OmnichannelKpiController {
  constructor(private readonly kpi: OmnichannelKpiService) {}

  // Management information: store manager and above, never a salesperson.
  @Roles('store_manager')
  @Get('summary')
  summary(@CurrentUser() user: AuthUser, @Query() query: OmnichannelSummaryDto) {
    return this.kpi.summary(user, query);
  }
}
