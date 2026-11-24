import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
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
 * PATCH /parties/:id — give a customer a readable name (client, 19 Nov).
 *
 * `@IsRealName` is the same guard the add form uses: a rename that produces
 * "9825012345" or "..." leaves the list exactly as unreadable as the hearts and
 * symbols it was meant to fix.
 */
export class RenamePartyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsRealName()
  name!: string;
}

/**
 * POST /parties/:id/branch — hand a customer to a branch (client, 23 Nov):
 * "people who have no branch should be visible only to head office, from where
 * they could be reassigned."
 *
 * One field, and it is required: there is no "take the branch away" here. A
 * customer with no branch is one only head office can see, so clearing it would
 * be a way to quietly pull somebody off a shop's list and into a queue nobody
 * below head office works.
 */
export class AssignPartyBranchDto {
  @IsString()
  @IsNotEmpty()
  storeId!: string;
}

/**
 * POST /parties/bulk-delete — remove the customers somebody ticked.
 *
 * Capped, because the ids can only have come from one page of the directory and
 * every one of them costs a history count. A cap that matches the largest page
 * the list offers keeps "select everything on this page" working and refuses a
 * hand-written request to sweep the whole tenant in one call.
 */
export class BulkDeletePartiesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  ids!: string[];
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
