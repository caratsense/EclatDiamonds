import { Body, Controller, Get, Post } from '@nestjs/common';
import { NewStoreService } from './new-store.service';
import { CreateProjectDto } from './dto/new-store.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { Roles } from '../auth/roles.decorator';

/** New-store setup is an area-manager / head-office programme. */
@Roles('area_manager', 'head_office')
@Controller('new-store')
export class NewStoreController {
  constructor(private readonly newStore: NewStoreService) {}

  @Get('projects')
  projects(@CurrentUser() user: AuthUser) {
    return this.newStore.projects(user);
  }

  @Post('projects')
  createProject(@CurrentUser() user: AuthUser, @Body() dto: CreateProjectDto) {
    return this.newStore.createProject(user, dto);
  }
}
