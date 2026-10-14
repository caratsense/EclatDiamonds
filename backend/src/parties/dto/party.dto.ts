import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsCustomerPhone, IsRealName } from '../../common/contact.util';

/**
 * POST /parties — add a customer from the shop floor (reps create customers;
 * store scope still enforced server-side). Phone takes an Indian mobile or an
 * international number — customers may be foreign (client, 13 Oct); email is
 * checked with `isValidEmail` in the service.
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
  @IsCustomerPhone()
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
