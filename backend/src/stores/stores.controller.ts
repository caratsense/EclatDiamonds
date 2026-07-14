import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { StoresService } from './stores.service';
import { CreateManagerDto, CreateStoreDto, UpdateStoreDto } from './dto/stores.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { Roles } from '../auth/roles.decorator';

@Controller('stores')
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  /**
   * GET /stores — the stores in the caller's scope (store-scoped, all roles),
   * each enriched with its assigned store-manager(s). Doubles as the admin list.
   */
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.stores.list(user);
  }

  /** GET /stores/pending — branches awaiting setup, in the caller's scope (area manager+). */
  @Roles('area_manager')
  @Get('pending')
  pending(@CurrentUser() user: AuthUser) {
    return this.stores.listPending(user);
  }

  /** POST /stores — provision a new branch (area manager+; AM limited to their regions). */
  @Roles('area_manager')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateStoreDto) {
    return this.stores.create(user, dto);
  }

  /** PATCH /stores/:id/activate — flip a pending branch to active (area manager+, in scope). */
  @Roles('area_manager')
  @Patch(':id/activate')
  activate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.stores.activate(user, id);
  }

  /** PATCH /stores/:id/close — soft-close a branch (head office only). */
  @Roles('head_office')
  @Patch(':id/close')
  close(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.stores.close(user, id);
  }

  /** PATCH /stores/:id — edit a branch (head office only; aggregate is immutable). */
  @Roles('head_office')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateStoreDto) {
    return this.stores.update(id, dto);
  }

  /** POST /stores/:id/manager — create/link the store-manager login (head office only). */
  @Roles('head_office')
  @Post(':id/manager')
  addManager(@Param('id') id: string, @Body() dto: CreateManagerDto) {
    return this.stores.addManager(id, dto);
  }
}
