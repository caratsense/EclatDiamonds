import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { EmployeesService } from './employees.service';
import {
  BulkEmployeesDto,
  CreateEmployeeDto,
  DepartmentDto,
  DesignationDto,
  EmployeeQueryDto,
  SeparateEmployeeDto,
  UpdateDepartmentDto,
  UpdateDesignationDto,
  UpdateEmployeeDto,
} from './dto/employees.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { Roles } from '../auth/roles.decorator';
import { StoreHeader } from '../common/store-header.decorator';

type Upload = { buffer?: Buffer; originalname?: string };

/** Employee master, masters and the EzAttendance import (docs/modules/06-attendance.md). */
@Controller('hrms')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  // --- Departments ------------------------------------------------------------

  @Roles('store_manager')
  @Get('departments')
  departments(@CurrentUser() user: AuthUser) {
    return this.employees.listDepartments(user);
  }

  @Roles('head_office')
  @Post('departments')
  createDepartment(@CurrentUser() user: AuthUser, @Body() dto: DepartmentDto) {
    return this.employees.createDepartment(user, dto);
  }

  @Roles('head_office')
  @Patch('departments/:id')
  updateDepartment(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateDepartmentDto) {
    return this.employees.updateDepartment(user, id, dto);
  }

  @Roles('head_office')
  @Delete('departments/:id')
  deleteDepartment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('reassignTo') reassignTo?: string,
  ) {
    return this.employees.deleteDepartment(user, id, reassignTo || undefined);
  }

  // --- Designations -----------------------------------------------------------

  @Roles('store_manager')
  @Get('designations')
  designations(@CurrentUser() user: AuthUser) {
    return this.employees.listDesignations(user);
  }

  @Roles('head_office')
  @Post('designations')
  createDesignation(@CurrentUser() user: AuthUser, @Body() dto: DesignationDto) {
    return this.employees.createDesignation(user, dto);
  }

  @Roles('head_office')
  @Patch('designations/:id')
  updateDesignation(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateDesignationDto,
  ) {
    return this.employees.updateDesignation(user, id, dto);
  }

  @Roles('head_office')
  @Delete('designations/:id')
  deleteDesignation(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('reassignTo') reassignTo?: string,
  ) {
    return this.employees.deleteDesignation(user, id, reassignTo || undefined);
  }

  // --- Employees (static routes before :userId) ------------------------------

  @Roles('store_manager')
  @Get('employees')
  list(@CurrentUser() user: AuthUser, @Query() query: EmployeeQueryDto, @StoreHeader() store?: string) {
    return this.employees.list(user, { ...query, storeId: query.storeId || store });
  }

  @Roles('store_manager')
  @Post('employees/bulk')
  bulk(@CurrentUser() user: AuthUser, @Body() dto: BulkEmployeesDto) {
    return this.employees.bulk(user, dto);
  }

  @Roles('store_manager')
  @Post('employees')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateEmployeeDto) {
    return this.employees.create(user, dto);
  }

  @Roles('store_manager')
  @Get('employees/:userId')
  detail(@CurrentUser() user: AuthUser, @Param('userId') userId: string) {
    return this.employees.detail(user, userId);
  }

  @Roles('store_manager')
  @Patch('employees/:userId')
  update(@CurrentUser() user: AuthUser, @Param('userId') userId: string, @Body() dto: UpdateEmployeeDto) {
    return this.employees.update(user, userId, dto);
  }

  /** Separates; `?purge=1` (head office) also removes a profile that has no history. */
  @Roles('store_manager')
  @Delete('employees/:userId')
  separate(
    @CurrentUser() user: AuthUser,
    @Param('userId') userId: string,
    @Body() dto: SeparateEmployeeDto,
    @Query('purge') purge?: string,
  ) {
    return this.employees.separate(user, userId, dto ?? {}, purge === '1' || purge === 'true');
  }

  // --- EzAttendancePRO import ---------------------------------------------------

  @Roles('head_office')
  @Post('import/ezattendance')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'employees', maxCount: 1 },
        { name: 'leaveBalances', maxCount: 1 },
        { name: 'todaysPunch', maxCount: 1 },
      ],
      { limits: { fileSize: 2 * 1024 * 1024, files: 3, fields: 6, fieldSize: 64 * 1024 } },
    ),
  )
  importEzAttendance(
    @CurrentUser() user: AuthUser,
    @UploadedFiles()
    files: { employees?: Upload[]; leaveBalances?: Upload[]; todaysPunch?: Upload[] } | undefined,
    @Body('dryRun') dryRun?: string,
    @Body('departmentStores') departmentStores?: string,
    @Body('attendanceDate') attendanceDate?: string,
  ) {
    return this.employees.importEzAttendance(
      user,
      {
        employees: files?.employees?.[0],
        leaveBalances: files?.leaveBalances?.[0],
        todaysPunch: files?.todaysPunch?.[0],
      },
      {
        dryRun: dryRun === '1' || dryRun === 'true',
        departmentStores: departmentStores || undefined,
        attendanceDate: attendanceDate || undefined,
      },
    );
  }
}
