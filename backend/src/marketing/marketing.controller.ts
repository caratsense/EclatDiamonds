import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { MarketingService } from './marketing.service';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { Roles } from '../auth/roles.decorator';
import {
  CreateAgencyTaskDto,
  CreateAssetDto,
  CreateCampaignDto,
  UpdateAgencyTaskStatusDto,
  UpdateAssetStatusDto,
} from './dto/marketing.dto';

@Controller('marketing')
export class MarketingController {
  constructor(private readonly marketing: MarketingService) {}

  @Get('campaigns')
  campaigns(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.marketing.campaigns(user, store);
  }

  /** Launching campaigns spends marketing budget — area_manager+ only. */
  @Roles('store_manager', 'head_office')
  @Post('campaigns')
  createCampaign(@CurrentUser() user: AuthUser, @Body() dto: CreateCampaignDto) {
    return this.marketing.create(user, dto);
  }

  @Get('assets')
  assets(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.marketing.assets(user, store);
  }

  /** Add an agency deliverable to a campaign — store_manager+. */
  @Roles('store_manager')
  @Post('assets')
  createAsset(@CurrentUser() user: AuthUser, @Body() dto: CreateAssetDto) {
    return this.marketing.createAsset(user, dto);
  }

  /** Approve / reject a deliverable — area_manager+ only. */
  @Roles('store_manager')
  @Patch('assets/:id')
  updateAssetStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateAssetStatusDto,
  ) {
    return this.marketing.updateAssetStatus(user, id, dto);
  }

  @Get('agency-tasks')
  agencyTasks(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.marketing.agencyTasks(user, store);
  }

  /** Create an agency task — store_manager+. */
  @Roles('store_manager')
  @Post('agency-tasks')
  createAgencyTask(@CurrentUser() user: AuthUser, @Body() dto: CreateAgencyTaskDto) {
    return this.marketing.createAgencyTask(user, dto);
  }

  /** Progress an agency task — store_manager+. */
  @Roles('store_manager')
  @Patch('agency-tasks/:id')
  updateAgencyTaskStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateAgencyTaskStatusDto,
  ) {
    return this.marketing.updateAgencyTaskStatus(user, id, dto);
  }
}
