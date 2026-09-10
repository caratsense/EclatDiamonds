import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { IsRealName } from '../../common/contact.util';

/**
 * Public self-service tenant signup. The owner is granted head_office only
 * inside the brand-new organisation created by this same request.
 */
export class CreateOrganisationDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(140)
  organisationName!: string;

  /** Validated against the server-owned pack catalogue in AuthService. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  industryCode!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  @IsRealName()
  ownerName!: string;

  /** This is the new owner's actual login identifier. */
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9][0-9 ()-]{7,20}$/, {
    message: 'phone must be a valid international phone number',
  })
  phone?: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  primaryLocationName!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  city!: string;
}
