import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsIndianMobile, IsRealName } from '../../common/contact.util';

/**
 * POST /parties — add a customer from the shop floor (reps create customers;
 * store scope still enforced server-side). Phone reuses the app's Indian-mobile
 * validator; email is checked with `isValidEmail` in the service.
 */
export class CreatePartyDto {
  @IsString()
  @IsNotEmpty()
  storeId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsRealName()
  name!: string;

  @IsString()
  @IsIndianMobile()
  phone!: string;

  @IsOptional()
  @IsString()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  city?: string;
}


/**
 * Archiving takes a contact out of the working lists. It never deletes one, and
 * it never touches consent, opt-out or the blacklist — see PartyArchiveService.
 */
export class ArchivePartyDto {
  /**
   * Required, and required to be meaningful. "x" tells the next person nothing
   * about why a customer vanished from their list six months from now.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
