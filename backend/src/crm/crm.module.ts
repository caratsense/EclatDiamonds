import { Global, Module, forwardRef } from '@nestjs/common';

import { KnowledgeModule } from '../knowledge/knowledge.module';
import { OmnichannelModule } from '../omnichannel/omnichannel.module';
import { AiDraftsController } from './ai/ai-drafts.controller';
import { AiDraftsService } from './ai/ai-drafts.service';
import { KnowledgeRetrievalService } from './ai/knowledge-retrieval';
import { ProviderAiResponder } from './ai/provider-ai-responder';

import { ActivityService } from './activity.service';
import { ConversationsService } from './conversations.service';
import { Customer360Service } from './customer360.service';
import { IdentityService } from './identity.service';
import { PipelinesService } from './pipelines.service';
import { QualificationService } from './qualification.service';
import { AttributionService } from './attribution.service';
import { CrmAiProvider } from './crm-ai.provider';
import { AdSetRulesService } from './adset-rules.service';
import { AI_RESPONDER, ConversationAiGate } from './ai-responder';
import { RequalificationService } from './requalification.service';
import { AdvancedCrmService } from './advanced-crm.service';
import { LeadIntakeService } from './lead-intake.service';
import { LeadFormsService } from './lead-forms.service';
import { CampaignsService } from './campaigns.service';
import { AudiencesController, CampaignsController } from './campaigns.controller';
import { CrmImportLeadsController, CrmLeadFormsController, PublicLeadFormsController } from './lead-forms.controller';
import {
  CrmLeadAgeingController,
  CrmLeadQrController,
  CrmMergeController,
  CrmPublicQrCaptureController,
  CrmRoundRobinController,
  CrmSegmentsController,
} from './advanced-crm.controller';
import {
  CrmActivityController,
  CrmConversationsController,
  CrmCustomersController,
  CrmIdentityController,
  CrmPipelinesController,
} from './crm.controller';
import { CrmQualificationController, CrmAttributionController } from './crm-ai.controller';

/**
 * The CRM spine (CaratOS Phase A3). Every service is exported: other modules
 * write to the timeline and resolve identities rather than reimplementing either.
 *
 * @Global, following CommonModule's precedent for cross-cutting providers.
 * ActivityService is injected by nearly every feature module — leads, sales,
 * check-ins, payments — and threading an import through each of them buys
 * nothing but churn. It depends only on other global modules, so there are no
 * cycles.
 */
@Global()
@Module({
  // KnowledgeModule is not @Global, so retrieval needs it named here. The
  // dependency runs one way only (CRM reads knowledge; knowledge knows nothing
  // of CRM), so there is no cycle.
  /*
   * OmnichannelModule is a genuine two-way edge, not an accident.
   *
   * OmnichannelService needs ConversationsService to check that a caller may
   * touch a thread; ConversationAiGate needs OmnichannelService so an automatic
   * reply goes out through the same consent, window, template, outbox and audit
   * path a person's message does. Breaking it would mean duplicating a
   * permission check into the messaging layer, and a second copy of an access
   * rule is how the two copies eventually disagree.
   */
  imports: [KnowledgeModule, forwardRef(() => OmnichannelModule)],
  controllers: [
    CrmCustomersController,
    CrmIdentityController,
    CrmConversationsController,
    CrmPipelinesController,
    CrmActivityController,
    CrmQualificationController,
    CrmAttributionController,
    AiDraftsController,
    CrmMergeController,
    CrmSegmentsController,
    CrmLeadAgeingController,
    CrmRoundRobinController,
    CrmLeadQrController,
    CrmPublicQrCaptureController,
    CrmLeadFormsController,
    PublicLeadFormsController,
    CrmImportLeadsController,
    AudiencesController,
    CampaignsController,
  ],
  providers: [
    IdentityService,
    ActivityService,
    Customer360Service,
    ConversationsService,
    PipelinesService,
    QualificationService,
    AttributionService,
    CrmAiProvider,
    AdSetRulesService,
    ConversationAiGate,
    KnowledgeRetrievalService,
    AiDraftsService,
    RequalificationService,
    AdvancedCrmService,
    LeadIntakeService,
    LeadFormsService,
    CampaignsService,
    // The default binding: honestly reports "no provider configured" rather than
    // leaving the token undefined. A real adapter replaces this when credentials
    // exist; tests replace it with a spy to assert invoked / not invoked.
    // The real adapter. With no CRM_AI_* credentials it reports itself
    // unconfigured — identical behaviour to the old stub — so binding it here
    // cannot switch anything on by itself. Tests still override the token.
    { provide: AI_RESPONDER, useClass: ProviderAiResponder },
  ],
  exports: [
    ConversationAiGate,
    AiDraftsService,
    KnowledgeRetrievalService,
    RequalificationService,
    IdentityService,
    ActivityService,
    Customer360Service,
    ConversationsService,
    PipelinesService,
    QualificationService,
    AttributionService,
    AdSetRulesService,
    AdvancedCrmService,
    LeadIntakeService,
    LeadFormsService,
    CampaignsService,
  ],
})
export class CrmModule {}
