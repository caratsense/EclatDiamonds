import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

import { AuthUser, CurrentUser } from '../common/auth-user';
import { Roles } from '../auth/roles.decorator';
import { ActivityService } from './activity.service';
import { ConversationsService } from './conversations.service';
import { Customer360Service } from './customer360.service';
import { IdentityService, ContactKind } from './identity.service';
import { PipelinesService } from './pipelines.service';
import {
  BackfillIdentityDto,
  CreatePipelineDto,
  LinkContactDto,
  LookupCustomerDto,
  RecordInteractionDto,
  RejectMergeDto,
  ReplyDto,
  ResolveCustomerDto,
  UpdateConversationDto,
  UpsertStageDto,
} from './dto/crm.dto';

/**
 * Customer 360 + identity (Phase A3).
 *
 * `/crm/customers/lookup` is the showroom entry point: a salesperson types a
 * phone number and finds out who walked in, before anything is created.
 */
@Controller('crm/customers')
export class CrmCustomersController {
  constructor(
    private readonly customers: Customer360Service,
    private readonly identity: IdentityService,
    private readonly activity: ActivityService,
  ) {}

  /** Read-only "who is this?" — never creates a customer. */
  @Post('lookup')
  lookup(@CurrentUser() user: AuthUser, @Body() body: LookupCustomerDto) {
    return this.customers.lookup(user, body.kind, body.value);
  }

  /** Find or (optionally) create. `createIfMissing` must be asked for explicitly. */
  @Post('resolve')
  resolve(@CurrentUser() user: AuthUser, @Body() body: ResolveCustomerDto) {
    return this.identity.resolve(
      user,
      { kind: body.kind as ContactKind, value: body.value, name: body.name, storeId: body.storeId },
      { createIfMissing: body.createIfMissing ?? false },
    );
  }

  @Get(':id')
  profile(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.customers.profile(user, id);
  }

  @Get(':id/timeline')
  timeline(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('types') types?: string,
  ) {
    return this.activity.timelineForParty(user, id, {
      limit: limit ? Number(limit) : undefined,
      cursor,
      types: types ? types.split(',').filter(Boolean) : undefined,
    });
  }

  @Get(':id/contacts')
  contacts(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.identity.contactPointsFor(user, id);
  }

  @Post(':id/contacts')
  link(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: LinkContactDto) {
    return this.identity.link(user, id, {
      kind: body.kind as ContactKind,
      value: body.value,
      isPrimary: body.isPrimary,
    });
  }

  @Delete('contacts/:contactPointId')
  unlink(@CurrentUser() user: AuthUser, @Param('contactPointId') contactPointId: string) {
    return this.identity.unlink(user, contactPointId);
  }

  /** Record product interest — the showroom "she tried this on". */
  @Post('interactions')
  interaction(@CurrentUser() user: AuthUser, @Body() body: RecordInteractionDto) {
    return this.customers.recordInteraction(user, body);
  }
}

/** Identity housekeeping — head office only, because it spans the whole tenant. */
@Roles('head_office')
@Controller('crm/identity')
export class CrmIdentityController {
  constructor(private readonly identity: IdentityService) {}

  /**
   * Build ContactPoints from the existing Party.phone/email snapshots. Safe to
   * re-run; never reassigns an identity that another customer already holds.
   */
  @Post('backfill')
  backfill(@CurrentUser() user: AuthUser, @Body() body: BackfillIdentityDto) {
    return this.identity.backfillFromParties(user, body.limit ?? 1000);
  }

  @Get('merge-candidates')
  mergeCandidates(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    return this.identity.listMergeCandidates(user, status ?? 'open');
  }

  /** Dismiss a review. Actually merging two customers is not implemented. */
  @Post('merge-candidates/:id/reject')
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: RejectMergeDto) {
    return this.identity.rejectMergeCandidate(user, id, body.reason);
  }
}

/** The unified inbox (Phase A3). Channel-neutral. */

export class AssignConversationDto {
  /** null clears the store (returns the thread to the central queue). */
  @IsOptional() @ValidateIf((o) => o.storeId !== null) @IsString()
  storeId?: string | null;

  /** null unassigns. Explicitly nullable - the old @IsString() made unassigning impossible. */
  @IsOptional() @ValidateIf((o) => o.assignedUserId !== null) @IsString()
  assignedUserId?: string | null;

  @IsOptional() @IsIn(['ai', 'human', 'unassigned'])
  handling?: string;

  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

export class ConvertConversationDto {
  /** Optional when the thread already has a branch; required when it does not. */
  @IsOptional() @IsString() @IsNotEmpty()
  storeId?: string;

  @IsString() @IsNotEmpty() @MaxLength(280)
  interest!: string;

  /** Lets the salesperson put a real name on a thread that only has a number. */
  @IsOptional() @IsString() @MaxLength(120)
  customerName?: string;
}

export class ResolveRoutingConflictDto {
  @IsIn(['kept_original', 'accepted_proposed', 'manual'])
  decision!: 'kept_original' | 'accepted_proposed' | 'manual';

  @IsOptional() @ValidateIf((o) => o.storeId !== null) @IsString()
  storeId?: string | null;

  @IsOptional() @ValidateIf((o) => o.assignedUserId !== null) @IsString()
  assignedUserId?: string | null;

  /** Only read for the 'manual' decision; validated by assign() like any other. */
  @IsOptional() @IsIn(['ai', 'human', 'unassigned'])
  handling?: string;

  @IsOptional() @IsString() @MaxLength(500)
  note?: string;
}

@Controller('crm/conversations')
export class CrmConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('handling') handling?: string,
    @Query('channel') channel?: string,
    @Query('mine') mine?: string,
    @Query('limit') limit?: string,
    @Query('routingReview') routingReview?: string,
    @Query('unidentified') unidentified?: string,
    @Query('storeId') storeId?: string,
  ) {
    // Every one of these narrows the caller's own scope; none widens it. The
    // store filter is asserted against their allowed stores in the service.
    return this.conversations.list(user, {
      status,
      handling,
      channel,
      assignedToMe: mine === 'true',
      routingReview: routingReview === 'true',
      unidentified: unidentified === 'true',
      storeId: storeId || undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  /**
   * How many threads are in each queue, for this caller.
   *
   * Declared before `@Get(':id')` deliberately — Nest matches in declaration
   * order, so a route added below it would be swallowed by the id parameter.
   */
  @Get('queues')
  queues(@CurrentUser() user: AuthUser) {
    return this.conversations.queueCounts(user);
  }

  /**
   * 1E - route/assign in one command.
   *
   * Store, owner and handling change together after ONE validation pass, so a
   * conversation can never end up owned by somebody who does not work at the
   * branch it now belongs to.
   *
   * Store manager and above. Reassigning work between branches and people is a
   * supervisory act; a salesperson takes a thread over by replying to it, which
   * is a different thing and stays open to them. The rank is enforced here, on
   * the server — the UI hides the button as a courtesy, not as a control.
   */
  @Roles('store_manager')
  @Post(':id/assign')
  assign(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AssignConversationDto,
  ) {
    return this.conversations.assign(user, id, dto);
  }

  /**
   * Turn an ordinary conversation into a lead, because a person decided it is
   * one. Salesperson and above: the rep reading the thread is exactly who should
   * make this call, unlike reassigning work between branches.
   */
  @Post(':id/convert-to-lead')
  convertToLead(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ConvertConversationDto,
  ) {
    return this.conversations.convertToLead(user, id, dto);
  }

  /**
   * Routing conflicts the caller may see.
   *
   * `state` is open | resolved | all (default open). A conversation's detail
   * panel asks for `all` on purpose: a resolved conflict is the record of a
   * decision a person made, and it stays readable after it is answered.
   */
  @Get('routing-conflicts')
  routingConflicts(
    @CurrentUser() user: AuthUser,
    @Query('state') state?: string,
    @Query('conversationId') conversationId?: string,
  ) {
    return this.conversations.routingConflicts(user, {
      state: state === 'resolved' || state === 'all' ? state : 'open',
      conversationId: conversationId || undefined,
    });
  }

  /** 1B - decide a routing conflict. Store managers and above. */
  @Roles('store_manager', 'head_office')
  @Post('routing-conflicts/:conflictId/resolve')
  resolveRoutingConflict(
    @CurrentUser() user: AuthUser,
    @Param('conflictId') conflictId: string,
    @Body() dto: ResolveRoutingConflictDto,
  ) {
    return this.conversations.resolveRoutingConflict(user, conflictId, dto);
  }

  @Get(':id')
  thread(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('limit') limit?: string) {
    return this.conversations.thread(user, id, limit ? Number(limit) : 100);
  }

  /** Saves the reply and marks it queued — see ConversationsService.queueOutbound. */
  @Post(':id/messages')
  reply(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: ReplyDto) {
    return this.conversations.queueOutbound(user, id, body);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: UpdateConversationDto,
  ) {
    return this.conversations.update(user, id, body);
  }
}

/** Configurable funnels. Reads open to all; writes head office only. */
@Controller('crm/pipelines')
export class CrmPipelinesController {
  constructor(private readonly pipelines: PipelinesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('entity') entity?: string) {
    return this.pipelines.list(user, entity ?? 'lead');
  }

  @Roles('head_office')
  @Post('ensure-default')
  ensureDefault(@CurrentUser() user: AuthUser) {
    return this.pipelines.ensureDefault(user);
  }

  @Roles('head_office')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: CreatePipelineDto) {
    return this.pipelines.createPipeline(user, body);
  }

  @Roles('head_office')
  @Post(':id/stages')
  upsertStage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: UpsertStageDto,
  ) {
    return this.pipelines.upsertStage(user, id, body);
  }

  @Roles('head_office')
  @Delete('stages/:stageId')
  deactivateStage(@CurrentUser() user: AuthUser, @Param('stageId') stageId: string) {
    return this.pipelines.deactivateStage(user, stageId);
  }
}

/** The organisation-wide activity feed. */
@Controller('crm/activity')
export class CrmActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  feed(
    @CurrentUser() user: AuthUser,
    @Query('limit') limit?: string,
    @Query('types') types?: string,
    @Query('storeId') storeId?: string,
    @Query('since') since?: string,
  ) {
    const parsedSince = since ? new Date(since) : undefined;
    return this.activity.feed(user, {
      limit: limit ? Number(limit) : undefined,
      types: types ? types.split(',').filter(Boolean) : undefined,
      storeId,
      since: parsedSince && !Number.isNaN(parsedSince.valueOf()) ? parsedSince : undefined,
    });
  }
}
