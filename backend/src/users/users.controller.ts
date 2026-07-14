import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto, UpdateUserRoleDto, UpdateUserStoreDto } from './dto/users.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { Roles } from '../auth/roles.decorator';

/**
 * Head-office staff management. Every route is HO-only: HO onboards everyone
 * (default salesperson), promotes/demotes, and reassigns primary stores.
 * Password resets reuse POST /auth/reset-password — not duplicated here.
 */
@Roles('head_office')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** GET /users — list all staff with their store assignments. */
  @Get()
  list() {
    return this.users.list();
  }

  /** POST /users — onboard a staff member (defaults to salesperson). */
  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  /** PATCH /users/:id/role — promote/demote (never to head_office). */
  @Patch(':id/role')
  updateRole(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserRoleDto,
  ) {
    return this.users.updateRole(user, id, dto);
  }

  /** PATCH /users/:id/store — reassign the user's primary store. */
  @Patch(':id/store')
  updateStore(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserStoreDto,
  ) {
    return this.users.updateStore(user, id, dto);
  }
}
