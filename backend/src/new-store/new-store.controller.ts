import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { NewStoreService } from './new-store.service';
import {
  AddChecklistItemDto,
  AddMilestoneDto,
  AddVendorDto,
  CreateProjectDto,
  UpdateChecklistItemDto,
  UpdateMilestoneDto,
  UpdateVendorDto,
} from './dto/new-store.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { Roles } from '../auth/roles.decorator';

/** New-store setup is an area-manager / head-office programme. */
@Roles('store_manager', 'head_office')
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

  @Post('projects/:id/checklist')
  addChecklistItem(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AddChecklistItemDto,
  ) {
    return this.newStore.addChecklistItem(user, id, dto);
  }

  @Patch('checklist/:id')
  updateChecklistItem(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateChecklistItemDto,
  ) {
    return this.newStore.updateChecklistItem(user, id, dto);
  }

  @Post('projects/:id/milestones')
  addMilestone(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AddMilestoneDto,
  ) {
    return this.newStore.addMilestone(user, id, dto);
  }

  @Patch('milestones/:id')
  updateMilestone(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateMilestoneDto,
  ) {
    return this.newStore.updateMilestone(user, id, dto);
  }

  @Post('projects/:id/vendors')
  addVendor(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AddVendorDto,
  ) {
    return this.newStore.addVendor(user, id, dto);
  }

  @Patch('vendors/:id')
  updateVendor(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateVendorDto,
  ) {
    return this.newStore.updateVendor(user, id, dto);
  }
}
