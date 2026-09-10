import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { StoresService } from './stores.service';
import { CreateManagerDto, CreateStoreDto, UpdateStoreDto } from './dto/stores.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { Roles } from '../auth/roles.decorator';
import { Public } from '../auth/public.decorator';

@Controller('stores')
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  /**
   * GET /stores/directory?org=<slug|id> — public list of branches (id/name/city
   * only) for the self-signup store picker, before the applicant has any session.
   * REQUIRES an explicit org param so this does not enumerate every tenant's
   * branches (audit §I-4); without it the response is []. The signup UI passes
   * the organisation it is signing into.
   */
  @Public()
  @Get('directory')
  directory(@Query('org') org?: string) {
    return this.stores.directory(org);
  }

  /**
   * GET /stores — the stores in the caller's scope (store-scoped, all roles),
   * each enriched with its assigned store-manager(s). Doubles as the admin list.
   */
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.stores.list(user);
  }

  /** GET /stores/pending — branches awaiting setup (head office only; store lifecycle). */
  @Roles('head_office')
  @Get('pending')
  pending(@CurrentUser() user: AuthUser) {
    return this.stores.listPending(user);
  }

  /** POST /stores — provision a new branch (head office only; the whole store lifecycle is). */
  @Roles('head_office')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateStoreDto) {
    return this.stores.create(user, dto);
  }

  /** PATCH /stores/:id/activate — flip a pending branch to active (head office only). */
  @Roles('head_office')
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
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateStoreDto) {
    return this.stores.update(user, id, dto);
  }

  /** POST /stores/:id/manager — create/link the store-manager login (head office only). */
  @Roles('head_office')
  @Post(':id/manager')
  addManager(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CreateManagerDto) {
    return this.stores.addManager(user, id, dto);
  }
}
