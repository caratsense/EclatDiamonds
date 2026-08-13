import { IsOptional, IsString } from 'class-validator';
import { IsIndianMobile } from '../../common/contact.util';

/**
 * POST /parties — add a customer from the shop floor (reps create customers;
 * store scope still enforced server-side). Phone reuses the app's Indian-mobile
 * validator; email is checked with `isValidEmail` in the service.
 */
export class CreatePartyDto {
  @IsString()
  storeId!: string;

  @IsString()
  name!: string;

  @IsString()
  @IsIndianMobile()
  phone!: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  city?: string;
}
