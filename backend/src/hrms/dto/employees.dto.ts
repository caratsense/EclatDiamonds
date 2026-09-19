import { Transform } from 'class-transformer';
import { ACTIVE_ROLES } from '../../auth/access';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { EmploymentStatus, Role } from '@prisma/client';
import { IsRealName } from '../../common/contact.util';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MSG = { message: 'dates must be YYYY-MM-DD' };
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class DepartmentDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  /** The branch this department is; null for head-office teams. */
  @IsOptional()
  @IsString()
  storeId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateDepartmentDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  storeId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class DesignationDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateDesignationDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class EmployeeQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsString()
  departmentId?: string;

  @IsOptional()
  @IsString()
  designationId?: string;

  @IsOptional()
  @IsEnum(EmploymentStatus)
  status?: EmploymentStatus;

  @IsOptional()
  @IsString()
  storeId?: string;
}

/** Profile fields shared by create and update. Dates are YYYY-MM-DD. */
export class EmployeeProfileFieldsDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  biometricNo?: string | null;

  @IsOptional()
  @IsString()
  departmentId?: string | null;

  @IsOptional()
  @IsString()
  designationId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  unit?: string | null;

  @IsOptional()
  @IsString()
  reportingManagerId?: string | null;

  @IsOptional()
  @IsIn(['M', 'F', 'O'])
  gender?: string | null;

  @IsOptional()
  @Matches(DATE, DATE_MSG)
  dateOfBirth?: string | null;

  @IsOptional()
  @Matches(DATE, DATE_MSG)
  dateOfJoining?: string | null;

  @IsOptional()
  @Matches(DATE, DATE_MSG)
  dateOfConfirmation?: string | null;

  @IsOptional()
  @IsIn(['full_time', 'part_time', 'contract'])
  employmentType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5)
  bloodGroup?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string | null;

  @IsOptional()
  @IsEmail()
  personalEmail?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  shiftCode?: string | null;

  /** 'separated' is set through DELETE /hrms/employees/:userId, never here. */
  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive';
}

export class CreateEmployeeDto extends EmployeeProfileFieldsDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsRealName()
  name!: string;

  @IsOptional()
  @Matches(/^[+\d][\d\s-]{6,19}$/, { message: 'phone looks invalid' })
  phone?: string;

  @IsIn(ACTIVE_ROLES, { message: 'role must be salesperson, store_manager, marketing or head_office' })
  role!: Role;

  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  storeIds!: string[];

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  employeeCode!: string;
}

export class UpdateEmployeeDto extends EmployeeProfileFieldsDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsRealName()
  name?: string;

  @IsOptional()
  @Matches(/^[+\d][\d\s-]{6,19}$/, { message: 'phone looks invalid' })
  phone?: string | null;

  @IsOptional()
  @IsIn(ACTIVE_ROLES, { message: 'role must be salesperson, store_manager, marketing or head_office' })
  role?: Role;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  storeIds?: string[];

  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  employeeCode?: string;
}

export class SeparateEmployeeDto {
  @IsOptional()
  @Matches(DATE, DATE_MSG)
  exitDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  exitReason?: string;
}

export class BulkEmployeesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  userIds!: string[];

  @IsIn(['separate', 'activate', 'deactivate'])
  action!: 'separate' | 'activate' | 'deactivate';
}
