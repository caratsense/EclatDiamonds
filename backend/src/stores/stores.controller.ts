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

  /** POST /stores — provision a new branch (head office only). */
  @Roles('head_office')
  @Post()
  create(@Body() dto: CreateStoreDto) {
    return this.stores.create(dto);
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
