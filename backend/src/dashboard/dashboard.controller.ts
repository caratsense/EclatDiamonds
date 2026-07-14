import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
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

  @Get('kpis')
  kpis(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.dashboard.kpis(user, store);
  }

  @Get('charts')
  charts(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.dashboard.charts(user, store);
  }

  @Get('tasks')
  tasks(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.dashboard.listTasks(user, store);
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
