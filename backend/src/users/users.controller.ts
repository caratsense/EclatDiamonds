import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { UsersService } from './users.service';
import {
  CreateUserDto,
  DeactivateUserDto,
  UpdateUserRoleDto,
  UpdateUserStoreDto,
} from './dto/users.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { Roles } from '../auth/roles.decorator';

/**
 * Delegated staff management. Every mutation is scope- and rank-checked in the
 * service (a user may only touch principals STRICTLY BELOW their own rank, inside
 * their store scope). The role gate on each route is the coarse floor; the service
 * enforces the fine-grained delegation rule. Password resets reuse
 * POST /auth/reset-password — not duplicated here.
 */
@Roles('store_manager')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** GET /users — staff visible within the caller's store scope. */
  @Roles('store_manager')
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('storeId') storeId?: string) {
    return this.users.list(user, storeId);
  }

  /** GET /users/unassigned — active staff with no store link, pending assignment. */
  @Roles('store_manager')
  @Get('unassigned')
  listUnassigned(@CurrentUser() user: AuthUser) {
    return this.users.listUnassigned(user);
  }

  /** POST /users — onboard a staff member strictly below the caller's rank. */
  @Roles('store_manager')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateUserDto) {
    return this.users.create(user, dto);
  }

  /** PATCH /users/:id/role — delegated promote/demote (never to/at the caller's rank). */
  @Roles('area_manager')
  @Patch(':id/role')
  updateRole(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserRoleDto,
  ) {
    return this.users.updateRole(user, id, dto);
  }

  /** PATCH /users/:id/store — reassign the user's primary store within scope. */
  @Roles('area_manager')
  @Patch(':id/store')
  updateStore(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserStoreDto,
  ) {
    return this.users.updateStore(user, id, dto);
  }

  /** PATCH /users/:id/deactivate — offboard, optionally handing off open work. */
  @Roles('store_manager')
  @Patch(':id/deactivate')
  deactivate(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: DeactivateUserDto,
  ) {
    return this.users.deactivate(user, id, dto);
  }

  /** PATCH /users/:id/activate — reactivate an offboarded user. */
  @Roles('store_manager')
  @Patch(':id/activate')
  activate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.users.activate(user, id);
  }
}
