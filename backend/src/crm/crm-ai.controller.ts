import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { AttributionService } from './attribution.service';
import { QualificationService } from './qualification.service';
import type { QualificationPolicy } from './qualification-policy';
import { AdSetRulesService, type AdSetAutomationRule } from './adset-rules.service';
import { ConversationAiGate } from './ai-responder';
import { AuditService } from '../common/audit.service';

export class SaveAiSettingsDto {
  @IsOptional() @IsBoolean() qualificationEnabled?: boolean;
  @IsOptional() @IsBoolean() draftEnabled?: boolean;
  @IsOptional() @IsBoolean() autoSendEnabled?: boolean;
}

export class SaveAdSetRulesDto {
  @IsArray()
  rules!: AdSetAutomationRule[];
}

export class SavePolicyDto {
  /**
   * Validated field-by-field here so the global `forbidNonWhitelisted` pipe lets
   * the body through, and re-validated in depth by `resolvePolicy`.
   *
   * The nested arrays are checked only for being arrays. That is deliberate, not
   * laziness: `resolvePolicy` already drops any malformed signal or band and
   * falls back to the default, and it has to be tolerant anyway because it also
   * reads documents written by older releases. A strict nested DTO would be a
   * SECOND definition of "a valid policy" that could disagree with the first,
   * and the disagreement would show up as an edit that saves but does nothing.
   */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  signals?: QualificationPolicy['signals'];

  @IsOptional()
  @IsArray()
  bands?: QualificationPolicy['bands'];

  @IsOptional()
  @IsArray()
  questions?: QualificationPolicy['questions'];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  confidenceThreshold?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  minMessagesToScore?: number;

  /** Null is meaningful: it switches score-based escalation off entirely. */
  @IsOptional()
  @IsInt()
  handoffAtScore?: number | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  handoffSignals?: string[];

  @IsOptional()
  @IsBoolean()
  summarise?: boolean;
}

export class AttributionModelQuery {
  @IsOptional()
  @IsIn(['first_touch', 'last_touch'])
  model?: 'first_touch' | 'last_touch';
}

/**
 * CRM qualification (Phase A9).
 *
 * Reads are open to any signed-in user — a salesperson needs to know whether the
 * lead in front of them is worth a call. Writing the POLICY is head office only:
 * it decides how every lead in the organisation is ranked.
 */
@Controller('crm/qualification')
export class CrmQualificationController {
  constructor(
    private readonly qualification: QualificationService,
    private readonly adSetRules: AdSetRulesService,
    private readonly aiGate: ConversationAiGate,
    private readonly audit: AuditService,
  ) {}


  /**
   * 1G - the three AI switches.
   *
   * Readable by any signed-in user (the inbox shows whether the assistant is on),
   * writable by head office only: it decides whether a model touches customer
   * conversations across the whole organisation.
   */
  // Management information: store manager and above, never a salesperson.
  @Roles('store_manager')
  @Get('ai-settings')
  aiSettings(@CurrentUser() user: AuthUser) {
    return this.aiGate.settings(user.organisationId);
  }

  @Roles('head_office')
  @Post('ai-settings')
  async saveAiSettings(@CurrentUser() user: AuthUser, @Body() dto: SaveAiSettingsDto) {
    const before = await this.aiGate.settings(user.organisationId);
    const after = await this.aiGate.saveSettings(user.organisationId, dto);
    await this.audit.record(user, {
      action: 'crm.ai_settings_updated',
      entityType: 'Organisation',
      entityId: user.organisationId,
      summary:
        `AI switches: qualification ${before.qualificationEnabled}->${after.qualificationEnabled}, ` +
        `draft ${before.draftEnabled}->${after.draftEnabled}, ` +
        `autoSend ${before.autoSendEnabled}->${after.autoSendEnabled}`,
      metadata: { before, after },
    });
    return after;
  }

  // Management information: store manager and above, never a salesperson.
  @Roles('store_manager')
  @Get('adset-rules')
  adSetRulesList(@CurrentUser() user: AuthUser) {
    return this.adSetRules.list(user.organisationId);
  }

  @Roles('head_office')
  @Post('adset-rules')
  saveAdSetRules(@CurrentUser() user: AuthUser, @Body() body: SaveAdSetRulesDto) {
    return this.adSetRules.replace(user, body.rules);
  }

  /** Current policy + whether an AI provider is actually configured. */
  // Management information: store manager and above, never a salesperson.
  @Roles('store_manager')
  @Get('policy')
  policy(@CurrentUser() user: AuthUser) {
    return this.qualification.describe(user);
  }

  @Roles('head_office')
  @Post('policy')
  savePolicy(@CurrentUser() user: AuthUser, @Body() body: SavePolicyDto) {
    return this.qualification.savePolicy(user, body);
  }

  /** Assess a conversation now. Returns an `unavailable` result rather than failing. */
  @Post('conversations/:id')
  assessConversation(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.qualification.assessConversation(user, id);
  }

  @Post('leads/:id')
  assessLead(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.qualification.assessLead(user, id);
  }

  /** The latest assessment for a subject. `null` means nobody has assessed it. */
  @Get('latest')
  latest(
    @CurrentUser() user: AuthUser,
    @Query('partyId') partyId?: string,
    @Query('leadId') leadId?: string,
    @Query('conversationId') conversationId?: string,
  ) {
    return this.qualification.latestFor(user, { partyId, leadId, conversationId });
  }

  @Get('history')
  history(
    @CurrentUser() user: AuthUser,
    @Query('partyId') partyId?: string,
    @Query('leadId') leadId?: string,
  ) {
    return this.qualification.historyFor(user, { partyId, leadId });
  }
}

/** Attribution (Phase A10) — declared vs measured, never blended. */
@Controller('crm/attribution')
export class CrmAttributionController {
  constructor(private readonly attribution: AttributionService) {}

  /** Where one customer came from, and what has been credited to it. */
  @Get('party/:partyId')
  forParty(@CurrentUser() user: AuthUser, @Param('partyId') partyId: string) {
    return this.attribution.forParty(user, partyId);
  }

  /**
   * Campaign rollup. Manager+ — a salesperson has no use for organisation-wide
   * marketing spend, and it is commercially sensitive.
   */
  @Roles('store_manager')
  @Get('campaigns')
  campaigns(@CurrentUser() user: AuthUser, @Query() query: AttributionModelQuery) {
    return this.attribution.campaignPerformance(user, query.model ?? 'last_touch');
  }
}
