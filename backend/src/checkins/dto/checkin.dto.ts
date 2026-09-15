import { LOCAL_DATETIME } from '../../crm/follow-up-reminders.service';
import {
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
import { CheckinOutcome, CheckinPurpose } from '@prisma/client';
import { IsIndianMobile, IsRealName } from '../../common/contact.util';

export class CreateCheckInDto {
  @IsString()
  @IsNotEmpty()
  storeId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsRealName()
  customerName!: string;

  @IsOptional()
  @IsString()
  @IsIndianMobile()
  phone?: string;

  @IsOptional()
  @IsEnum(CheckinPurpose)
  purpose?: CheckinPurpose;

  @IsOptional()
  @IsString()
  repId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @IsRealName()
  repName?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  partySize?: number;
}

export class CheckoutDto {
  @IsOptional()
  @IsEnum(CheckinOutcome)
  outcome?: CheckinOutcome;

  /**
   * What the customer actually said. Separate from `followUpDate` on purpose —
   * see the CheckIn model comment. Either may be sent without the other.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  remark?: string;

  /** `YYYY-MM-DD` in the store's own timezone. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'followUpDate must be YYYY-MM-DD.' })
  followUpDate?: string;

  /** Defaults to whoever served the visit. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  followUpOwnerId?: string;

  @IsOptional()
  @IsIn(['call', 'whatsapp', 'visit'])
  preferredAction?: 'call' | 'whatsapp' | 'visit';

  /**
   * When the employee is reminded, `YYYY-MM-DDTHH:MM` in the store's timezone.
   * Independent of the follow-up date: omitted, the tenant's default applies;
   * sent alone, the follow-up is due on the reminder's day.
   */
  @IsOptional()
  @Matches(LOCAL_DATETIME, { message: 'reminderAt must be YYYY-MM-DDTHH:MM.' })
  reminderAt?: string;
}
