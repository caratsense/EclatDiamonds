import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * PATCH /auth/me — the little a person may change about themselves: how to
 * reach them. Name, role, store and login ID stay with head office / HR.
 * An empty string clears the field.
 */
export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(254)
  contactEmail?: string;
}
