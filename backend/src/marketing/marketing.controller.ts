import { Body, Controller, Get, Post } from '@nestjs/common';
import { MarketingService } from './marketing.service';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { Roles } from '../auth/roles.decorator';
import { CreateCampaignDto } from './dto/marketing.dto';

@Controller('marketing')
export class MarketingController {
  constructor(private readonly marketing: MarketingService) {}

  @Get('campaigns')
  campaigns(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.marketing.campaigns(user, store);
  }

  @Roles('store_manager', 'area_manager', 'head_office')
  @Post('campaigns')
  createCampaign(@CurrentUser() user: AuthUser, @Body() dto: CreateCampaignDto) {
    return this.marketing.create(user, dto);
  }

  @Get('assets')
  assets(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.marketing.assets(user, store);
  }

  @Get('agency-tasks')
  agencyTasks(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.marketing.agencyTasks(user, store);
  }
}
