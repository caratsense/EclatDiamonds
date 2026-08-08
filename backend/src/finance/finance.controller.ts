import { Body, Controller, Get, Post } from '@nestjs/common';
import { FinanceService } from './finance.service';
import { CreateLedgerEntryDto } from './dto/finance.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { Roles } from '../auth/roles.decorator';

/**
 * Finance & Fund Planning (Module 4) is a Management-tier area: ledgers (AP/AR with
 * party names), P&L/EBITDA, budgets and cash-flow. The whole controller is gated to
 * area_manager and above — matching the frontend nav, which shows Finance to
 * area_manager+ only (security audit, 2026-07). Store-scoping inside the service
 * further restricts which stores an area manager can see.
 */
@Roles('store_manager', 'head_office')
@Controller('finance')
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get('ledger')
  ledger(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.finance.ledger(user, store);
  }

  @Post('ledger')
  createEntry(@CurrentUser() user: AuthUser, @Body() dto: CreateLedgerEntryDto) {
    return this.finance.createEntry(user, dto);
  }

  @Get('summary')
  summary(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.finance.summary(user, store);
  }

  @Get('budget')
  budget(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.finance.budget(user, store);
  }

  @Get('cashflow')
  cashflow(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.finance.cashflow(user, store);
  }
}
