import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { DashboardService } from './dashboard.service';
import {
  CreateHandoffDto,
  CreateTaskDto,
  UpdateHandoffStatusDto,
  UpdateTaskStatusDto,
} from './dto/dashboard.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  // Management information: store manager and above, never a salesperson.
  @Roles('store_manager')
  @Get('kpis')
  kpis(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.dashboard.kpis(user, store);
  }

  // Management information: store manager and above, never a salesperson.
  @Roles('store_manager')
  @Get('charts')
  charts(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.dashboard.charts(user, store);
  }

  @Get('tasks')
  tasks(
    @CurrentUser() user: AuthUser,
    @StoreHeader() store?: string,
    @Query('mine') mine?: string,
    @Query('status') status?: string,
    @Query('priority') priority?: string,
    @Query('partyId') partyId?: string,
    @Query('leadId') leadId?: string,
  ) {
    // `mine` resolves to the CALLER's id server-side. A client cannot ask for
    // someone else's tasks by passing a different id, because there is no id to
    // pass.
    return this.dashboard.listTasks(user, store, {
      mine: mine === 'true',
      status,
      priority,
      partyId,
      leadId,
    });
  }

  @Post('tasks')
  createTask(@CurrentUser() user: AuthUser, @Body() dto: CreateTaskDto) {
    return this.dashboard.createTask(user, dto);
  }

  @Patch('tasks/:id')
  updateTaskStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateTaskStatusDto,
  ) {
    return this.dashboard.updateTaskStatus(user, id, dto);
  }

  @Get('agenda')
  agenda(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.dashboard.agenda(user, store);
  }

  @Get('handoffs')
  handoffs(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.dashboard.listHandoffs(user, store);
  }

  /** Active staff in scope, for the hand-off "Assign to" picker. */
  // Management information: store manager and above, never a salesperson.
  @Roles('store_manager')
  @Get('assignable-users')
  assignableUsers(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.dashboard.assignableUsers(user, store);
  }

  @Post('handoffs')
  createHandoff(@CurrentUser() user: AuthUser, @Body() dto: CreateHandoffDto) {
    return this.dashboard.createHandoff(user, dto);
  }

  @Patch('handoffs/:id')
  updateHandoffStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateHandoffStatusDto,
  ) {
    return this.dashboard.updateHandoffStatus(user, id, dto);
  }
}
