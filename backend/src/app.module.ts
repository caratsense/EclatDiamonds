import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';

import { StoresModule } from './stores/stores.module';
import { UsersModule } from './users/users.module';
import { LeadsModule } from './leads/leads.module';
import { ProductsModule } from './products/products.module';
import { QuotesModule } from './quotes/quotes.module';
import { StockModule } from './stock/stock.module';
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
import { SyncModule } from './sync/sync.module';
import { StorageModule } from './storage/storage.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AuditModule } from './audit/audit.module';
import { TargetsModule } from './targets/targets.module';
import { HealthController } from './health/health.controller';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Global anti-abuse rate limit: 300 req / 60s per client IP. Generous by
    // design — a 500-user ops tool never hits this in normal use; it only stops
    // scripted abuse. OTP endpoints carry tighter per-route @Throttle overrides.
    // Per-IP accuracy behind Railway's proxy relies on `trust proxy` (main.ts).
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 300 }] }),
    PrismaModule,
    CommonModule,
    AuthModule,
    StoresModule,
    UsersModule,
    LeadsModule,
    ProductsModule,
    QuotesModule,
    StockModule,
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
    SyncModule,
    StorageModule,
    NotificationsModule,
    AuditModule,
    TargetsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Global auth: every route requires a valid JWT unless marked @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Role-hierarchy gate for routes annotated with @Roles().
    { provide: APP_GUARD, useClass: RolesGuard },
    // IP rate limit (registered last; guards run in registration order, though
    // ordering is not functionally required here — throttling is per-IP, not per-user).
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Catch-all error handling: structured 5xx logs, no internal leakage to the
    // client, and optional webhook alerting (ALERT_WEBHOOK_URL).
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
