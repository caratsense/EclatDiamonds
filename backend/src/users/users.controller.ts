import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { UsersService } from './users.service';
import {
  CreateCustomRoleDto,
  ApplyCustomRoleDto,
  ApproveUserDto,
  CreateUserDto,
  DeactivateUserDto,
  LocationCheckDto,
  UpdateUserDetailsDto,
  RejectUserDto,
  SetLeaveAllocationDto,
  SetUserAccessDto,
  SetUserStoresDto,
  UpdateSignupPolicyDto,
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

  /** GET /users/pending — self-signup approval queue (scoped to what the caller may grant). */
  @Roles('store_manager')
  @Get('pending')
  listPending(@CurrentUser() user: AuthUser) {
    return this.users.listPending(user);
  }

  /** GET /users/signup-policy — Login ID template + manager self-request switch (head office). */
  @Roles('head_office')
  @Get('signup-policy')
  signupPolicy(@CurrentUser() user: AuthUser) {
    return this.users.signupPolicy(user);
  }

  /** PUT /users/signup-policy — change them; applies to users created from now on. */
  @Roles('head_office')
  @Put('signup-policy')
  saveSignupPolicy(@CurrentUser() user: AuthUser, @Body() dto: UpdateSignupPolicyDto) {
    return this.users.saveSignupPolicy(user, dto);
  }

  // ── Custom roles (client, 9 Oct) — literal paths, declared before :id ────

  /** GET /users/roles/defaults?role= — a base role's default screen map. */
  @Roles('head_office')
  @Get('roles/defaults')
  roleDefaults(@CurrentUser() user: AuthUser, @Query('role') role: string) {
    return this.users.roleDefaultsFor(user, role as never);
  }

  /** GET /users/roles — the tenant's own named roles. */
  @Roles('store_manager')
  @Get('roles')
  listRoles(@CurrentUser() user: AuthUser) {
    return this.users.listRoles(user);
  }

  /** POST /users/roles — create one: a base role + saved screen overrides. */
  @Roles('head_office')
  @Post('roles')
  createRole(@CurrentUser() user: AuthUser, @Body() dto: CreateCustomRoleDto) {
    return this.users.createRole(user, dto as never);
  }

  /** PUT /users/roles/:roleId — re-save the template's screens. */
  @Roles('head_office')
  @Put('roles/:roleId')
  updateRoleTemplate(
    @CurrentUser() user: AuthUser,
    @Param('roleId') roleId: string,
    @Body() dto: SetUserAccessDto,
  ) {
    return this.users.updateRoleTemplate(user, roleId, dto);
  }

  /** DELETE /users/roles/:roleId — remove the template; nobody loses access. */
  @Roles('head_office')
  @Delete('roles/:roleId')
  deleteRole(@CurrentUser() user: AuthUser, @Param('roleId') roleId: string) {
    return this.users.deleteRole(user, roleId);
  }

  /** POST /users/:id/apply-role — stamp a template onto a person. */
  @Roles('head_office')
  @Post(':id/apply-role')
  applyRole(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ApplyCustomRoleDto,
  ) {
    return this.users.applyRole(user, id, dto.roleId);
  }

  /** POST /users/:id/approve — grant a pending signup (delegation-gated). */
  @Roles('store_manager')
  @Post(':id/approve')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ApproveUserDto,
  ) {
    return this.users.approve(user, id, dto);
  }

  /** POST /users/:id/reject — decline a pending signup (delegation-gated). */
  @Roles('store_manager')
  @Post(':id/reject')
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: RejectUserDto,
  ) {
    return this.users.reject(user, id, dto.reason);
  }

  /** PATCH /users/:id/leave-allocation — set a staff member's yearly leave quota. */
  @Roles('store_manager')
  @Patch(':id/leave-allocation')
  setLeaveAllocation(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SetLeaveAllocationDto,
  ) {
    return this.users.setLeaveAllocation(user, id, dto);
  }

  /** PATCH /users/:id/role — delegated promote/demote (never to/at the caller's rank). */
  @Roles('store_manager')
  @Patch(':id/role')
  updateRole(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserRoleDto,
  ) {
    return this.users.updateRole(user, id, dto);
  }

  /** PATCH /users/:id/store — reassign the user's primary store within scope. */
  @Roles('store_manager')
  /** PATCH /users/:id/stores — the exact set of branches an area manager covers. */
  @Patch(':id/stores')
  setStores(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SetUserStoresDto,
  ) {
    return this.users.setStores(user, id, dto.storeIds);
  }

  @Patch(':id/store')
  updateStore(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserStoreDto,
  ) {
    return this.users.updateStore(user, id, dto);
  }

  /** PATCH /users/:id — fix name, Login ID, contact email or phone in place. */
  @Roles('store_manager')
  @Patch(':id')
  updateDetails(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserDetailsDto,
  ) {
    return this.users.updateDetails(user, id, dto);
  }

  /**
   * DELETE /users/:id — only for an account with NO operational history (a
   * typo, a duplicate, a demo row); anyone with records is pointed at
   * Deactivate. Head office only.
   */
  @Roles('head_office')
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.users.remove(user, id);
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

  /**
   * PATCH /users/:id/location-check — hold this person's punches to the store
   * geofence (true, the default) or exempt them (false): travelling sales,
   * remote staff, branch floaters. Head office only - it waives a check.
   */
  @Roles('head_office')
  @Patch(':id/location-check')
  setLocationCheck(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: LocationCheckDto,
  ) {
    return this.users.setLocationCheck(user, id, dto.required);
  }

  /** PATCH /users/:id/activate — reactivate an offboarded user. */
  @Roles('store_manager')
  @Patch(':id/activate')
  activate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.users.activate(user, id);
  }

  /** GET /users/:id/access — what this person may open: role defaults, head office's changes, the result. */
  @Roles('head_office')
  @Get(':id/access')
  access(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.users.access(user, id);
  }

  /** PUT /users/:id/access — replace head office's changes for this person (audited). */
  @Roles('head_office')
  @Put(':id/access')
  setAccess(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SetUserAccessDto) {
    return this.users.setAccess(user, id, dto.overrides);
  }
}
