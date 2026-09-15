import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../auth/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { RateLimit } from '../common/rate-limit';
import { AdvancedCrmService } from './advanced-crm.service';
import {
  CaptureLeadFromQrDto,
  CreateLeadSegmentDto,
  IssueLeadQrDto,
  LeadAgeingQueryDto,
  MergeCustomersDto,
  PreviewLeadSegmentDto,
  ReplaceLeadAgeingPolicyDto,
  ReplaceRoundRobinPolicyDto,
  RoundRobinAssignDto,
} from './dto/advanced-crm.dto';

/** A reviewed customer merge: plan first, then execute exactly that plan. */
@Roles('head_office')
@Controller('crm/identity/merge-candidates')
export class CrmMergeController {
  constructor(private readonly advanced: AdvancedCrmService) {}

  @Get(':id/plan')
  plan(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.advanced.mergePlan(user, id);
  }

  @Post(':id/merge')
  merge(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: MergeCustomersDto,
  ) {
    return this.advanced.mergeCustomers(user, id, body.planHash);
  }
}

/** Dynamic previews plus tenant-saved lead segment definitions. */
@Controller('crm/segments')
export class CrmSegmentsController {
  constructor(private readonly advanced: AdvancedCrmService) {}

  // Management information: store manager and above, never a salesperson.
  @Roles('store_manager')
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.advanced.listSegments(user);
  }

  // Management information: store manager and above, never a salesperson.
  @Roles('store_manager')
  @Post('preview')
  @RateLimit('expensive')
  preview(@CurrentUser() user: AuthUser, @Body() body: PreviewLeadSegmentDto) {
    return this.advanced.previewSegment(user, body.filters, body.limit);
  }

  @Roles('store_manager')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: CreateLeadSegmentDto) {
    return this.advanced.createSegment(user, body.name, body.filters);
  }

  // Management information: store manager and above, never a salesperson.
  @Roles('store_manager')
  @Get(':id/results')
  @RateLimit('expensive')
  results(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.advanced.savedSegmentResults(user, id, limit ? Number(limit) : undefined);
  }

  @Roles('store_manager')
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.advanced.deleteSegment(user, id);
  }
}

/** Store-timezone-aware inactivity cohorts and tenant-owned SLA thresholds. */
@Controller('crm/leads/ageing')
export class CrmLeadAgeingController {
  constructor(private readonly advanced: AdvancedCrmService) {}

  // Owner-scoped in the service: a salesperson ages only their own leads.
  @Get()
  report(@CurrentUser() user: AuthUser, @Query() query: LeadAgeingQueryDto) {
    return this.advanced.leadAgeing(user, query);
  }

  @Get('policy')
  policy(@CurrentUser() user: AuthUser) {
    return this.advanced.getAgeingPolicy(user);
  }

  @Roles('head_office')
  @Put('policy')
  replacePolicy(@CurrentUser() user: AuthUser, @Body() body: ReplaceLeadAgeingPolicyDto) {
    return this.advanced.replaceAgeingPolicy(user, body);
  }
}

/** Explicit configuration plus an idempotent manual assignment command. */
@Controller('crm/round-robin')
export class CrmRoundRobinController {
  constructor(private readonly advanced: AdvancedCrmService) {}

  // Management information: store manager and above, never a salesperson.
  @Roles('store_manager')
  @Get('policy')
  policy(@CurrentUser() user: AuthUser) {
    return this.advanced.getRoundRobinPolicy(user);
  }

  @Roles('store_manager')
  @Put('policy')
  replacePolicy(@CurrentUser() user: AuthUser, @Body() body: ReplaceRoundRobinPolicyDto) {
    return this.advanced.replaceRoundRobinPolicy(user, body);
  }

  @Roles('store_manager')
  @Post('assign')
  assign(@CurrentUser() user: AuthUser, @Body() body: RoundRobinAssignDto) {
    return this.advanced.roundRobinAssign(user, body.entity, body.entityId);
  }
}

/** Authenticated QR issuance. The returned path is rendered as a QR by any UI. */
@Roles('store_manager')
@Controller('crm/lead-qr')
export class CrmLeadQrController {
  constructor(private readonly advanced: AdvancedCrmService) {}

  @Post()
  issue(@CurrentUser() user: AuthUser, @Body() body: IssueLeadQrDto) {
    return this.advanced.issueLeadQr(user, body);
  }
}

/**
 * The only anonymous Advanced CRM route. Tenant and store are authenticated by
 * the encrypted token, not by a request body field; the per-IP bound is tighter
 * than the ordinary public category because this route creates records.
 */
@Public()
@RateLimit('public')
@Controller('crm/qr/capture')
export class CrmPublicQrCaptureController {
  constructor(private readonly advanced: AdvancedCrmService) {}

  @Post(':token')
  @Throttle({ public: { limit: 10, ttl: 60_000 } })
  capture(@Param('token') token: string, @Body() body: CaptureLeadFromQrDto) {
    return this.advanced.captureLead(token, body);
  }
}

