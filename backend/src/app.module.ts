import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { EntitlementGuard } from './common/entitlement.guard';

import { StoresModule } from './stores/stores.module';
import { UsersModule } from './users/users.module';
import { LeadsModule } from './leads/leads.module';
import { PartiesModule } from './parties/parties.module';
import { ProductsModule } from './products/products.module';
import { QuotesModule } from './quotes/quotes.module';
import { StockModule } from './stock/stock.module';
import { StockTransfersModule } from './stock-transfers/stock-transfers.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DiscountsModule } from './discounts/discounts.module';
import { FinanceModule } from './finance/finance.module';
import { HrmsModule } from './hrms/hrms.module';
import { CheckinsModule } from './checkins/checkins.module';
import { TimelinesModule } from './timelines/timelines.module';
import { ReportingModule } from './reporting/reporting.module';
import { NewStoreModule } from './new-store/new-store.module';
import { PaymentsModule } from './payments/payments.module';
import { SalesModule } from './sales/sales.module';
import { TicketingModule } from './ticketing/ticketing.module';
import { ReturnsModule } from './returns/returns.module';
import { MarketingModule } from './marketing/marketing.module';
import { LoyaltyModule } from './loyalty/loyalty.module';
import { SearchModule } from './search/search.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { WhatsAppBotModule } from './whatsapp-bot/whatsapp-bot.module';
import { SyncModule } from './sync/sync.module';
import { StorageModule } from './storage/storage.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SpecialRequestsModule } from './special-requests/special-requests.module';
import { AssistantModule } from './assistant/assistant.module';
import { AuditModule } from './audit/audit.module';
import { TargetsModule } from './targets/targets.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { IntegrationModule } from './integration/integration.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { HealthController } from './health/health.controller';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { TenantContextMiddleware } from './common/tenant-context.middleware';
import { CategoryThrottlerGuard, rateLimitConfig } from './common/rate-limit';
import { RequestLoggingInterceptor } from './common/request-logging.interceptor';
import { TenantConfigModule } from './config/tenant-config.module';
import { CrmModule } from './crm/crm.module';
import { JobsModule } from './jobs/jobs.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { OmnichannelModule } from './omnichannel/omnichannel.module';
import { AttributionModule } from './attribution/attribution.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Rate limiting by CATEGORY (Phase B4) — auth / public / tenant / expensive
    // / integration, each with its own bucket and its own configurable limit.
    // Authenticated traffic is keyed on the organisation (or the user, for
    // expensive work) rather than the IP, so a whole store behind one office NAT
    // is not mistaken for an attack. See common/rate-limit.ts.
    ThrottlerModule.forRoot(rateLimitConfig()),
    PrismaModule,
    CommonModule,
    AuthModule,
    StoresModule,
    UsersModule,
    LeadsModule,
    PartiesModule,
    ProductsModule,
    QuotesModule,
    StockModule,
    StockTransfersModule,
    DashboardModule,
    DiscountsModule,
    FinanceModule,
    HrmsModule,
    CheckinsModule,
    TimelinesModule,
    ReportingModule,
    NewStoreModule,
    PaymentsModule,
    SalesModule,
    TicketingModule,
    ReturnsModule,
    MarketingModule,
    LoyaltyModule,
    SearchModule,
    IntegrationsModule,
    WhatsAppBotModule,
    SyncModule,
    StorageModule,
    NotificationsModule,
    SpecialRequestsModule,
    AssistantModule,
    AuditModule,
    TargetsModule,
    OnboardingModule,
    IntegrationModule,
    TenantConfigModule,
    CrmModule,
    JobsModule,
    KnowledgeModule,
    OmnichannelModule,
    // Measured ad spend and ROAS. Registering the module is what makes it exist
    // at runtime at all: without it the controller has no route AND
    // MetaAdsInsightsService.onModuleInit never runs, so the
    // `meta_ads.insights.pull` job handler is never registered and every such
    // job sits unclaimed. It was written but never imported.
    AttributionModule,
    // Last: its jobs drive the modules above.
    SchedulerModule,
  ],
  controllers: [HealthController],
  providers: [
    // Global auth: every route requires a valid JWT unless marked @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Role-hierarchy gate for routes annotated with @Roles().
    { provide: APP_GUARD, useClass: RolesGuard },
    // Industry gate: refuses a module the tenant's industry pack does not
    // include, whatever the caller's role. Runs after RolesGuard so a
    // request that fails both is reported as the role problem it also is.
    { provide: APP_GUARD, useClass: EntitlementGuard },
    // Rate limiting LAST: it keys on the authenticated principal, so it must run
    // after JwtAuthGuard has resolved one. Registration order is guard order in
    // Nest, and here that ordering is load-bearing rather than incidental.
    { provide: APP_GUARD, useClass: CategoryThrottlerGuard },
    // Catch-all error handling: structured 5xx logs, no internal leakage to the
    // client, and optional webhook alerting (ALERT_WEBHOOK_URL).
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Tenant-aware request log: correlation id, organisation, actor, duration.
    // Bodies and headers are never logged — see the interceptor for why that is
    // a blanket rule rather than a redaction list.
    { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor },
  ],
})
export class AppModule implements NestModule {
  /**
   * Opens the per-request AsyncLocalStorage scope before guards run, so
   * JwtAuthGuard can promote it to a tenant and everything downstream (logs,
   * jobs, later RLS) can read the tenant without threading it by hand.
   * Middleware — not an interceptor — because only middleware wraps the whole
   * downstream chain including the guards themselves.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}
