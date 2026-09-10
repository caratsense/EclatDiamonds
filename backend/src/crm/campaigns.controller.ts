import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { CampaignsService } from './campaigns.service';
import {
  CancelCampaignDto,
  CreateCampaignDto,
  CreateSegmentDto,
  ListCampaignsDto,
  ListRecipientsDto,
  SegmentDefinitionCarrierDto,
  UpdateCampaignDto,
  UpdateSegmentDto,
} from './dto/campaign.dto';

/**
 * Saved audiences.
 *
 * Mounted at /audiences and /campaigns, deliberately NOT under /crm or
 * /marketing.
 *
 *   - /crm is classified universal, so putting them there would hand an
 *     audience builder and a customer-messaging sender to every tenant with no
 *     gate at all.
 *   - /marketing is ALREADY TAKEN by the jewellery agency-planning controller,
 *     whose DTO demands a bridal/festive campaign type. Nesting under it would
 *     have been a live route collision, not just a naming preference.
 *
 * They carry their own `campaigns` capability, which is in core navigation, so
 * a clinic and a mill get outreach without claiming to run a bridal campaign.
 *
 * Store manager and above. A segment is not itself a send, but it decides who a
 * send reaches, and the preview beneath it returns customer names — so it is
 * gated at the same level as the campaign that will use it. Every query inside
 * the service is tenant-scoped and intersected with the caller's own branches;
 * naming another branch's id in `storeIds` is refused rather than silently
 * ignored.
 */
@Roles('store_manager')
@Controller('audiences')
export class AudiencesController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.campaigns.listSegments(user);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: CreateSegmentDto) {
    return this.campaigns.createSegment(user, body);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: UpdateSegmentDto) {
    return this.campaigns.updateSegment(user, id, body);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.campaigns.deleteSegment(user, id);
  }

  /**
   * POST, not GET, because the rule tree is a body: a segment definition does
   * not fit a query string, and putting customer-selection rules in a URL puts
   * them in every access log.
   */
  @Post('preview')
  preview(@CurrentUser() user: AuthUser, @Body() body: SegmentDefinitionCarrierDto) {
    return this.campaigns.previewAudience(user, body);
  }
}

@Roles('store_manager')
@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListCampaignsDto) {
    return this.campaigns.list(user, query);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.campaigns.get(user, id);
  }

  @Get(':id/recipients')
  recipients(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query() query: ListRecipientsDto,
  ) {
    return this.campaigns.recipients(user, id, query);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: CreateCampaignDto) {
    return this.campaigns.create(user, body);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: UpdateCampaignDto) {
    return this.campaigns.update(user, id, { ...body });
  }

  @Post(':id/submit')
  submit(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.campaigns.submit(user, id);
  }

  /**
   * Approval is checked again inside the service against the narrower approver
   * set. The class-level `store_manager` guard is the floor for reaching the
   * route at all, not the authority to release a campaign to customers.
   */
  @Post(':id/approve')
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.campaigns.approve(user, id);
  }

  @Post(':id/cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: CancelCampaignDto,
  ) {
    return this.campaigns.cancel(user, id, body.reason);
  }

  @Post(':id/retry')
  retry(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.campaigns.retryFailed(user, id);
  }
}
