import { Body, Controller, Get, Post } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { CreateTaskDto } from './dto/dashboard.dto';
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
}
