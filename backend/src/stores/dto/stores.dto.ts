import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsIndianMobile, IsRealName } from '../../common/contact.util';

/** POST /stores — head office provisions a new branch. */
export class CreateStoreDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  @IsRealName()
  name!: string;

  @IsString()
  @MinLength(2)
  city!: string;

  /** Human-readable code / slug; auto-generated from the name when omitted. */
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  regionId?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;
}

/** PATCH /stores/:id — edit a branch (aggregate stores are immutable). */
export class UpdateStoreDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @IsRealName()
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  city?: string;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  regionId?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  // Office address + contact. Editable because what the sync imports is only as
  // good as the client's branch master, which is often years out of date, and
  // these values print on customer-facing documents.
  @IsOptional()
  @IsString()
  addressLine1?: string;

  @IsOptional()
  @IsString()
  addressLine2?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  pincode?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  @IsIndianMobile()
  phone?: string;

  @IsOptional()
  @IsString()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  gstin?: string;
}

/** POST /stores/:id/manager — create (or link) the store-manager login for a branch. */
export class CreateManagerDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  @IsRealName()
  name!: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @IsIndianMobile()
  phone?: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}

/** POST /regions — optional grouping for stores (area rollups). */
export class CreateRegionDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  @IsRealName()
  name!: string;

  @IsOptional()
  @IsString()
  code?: string;
}
