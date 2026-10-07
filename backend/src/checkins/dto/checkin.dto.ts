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

  /*
   * The New Customer Data fields (client's walk-in form, 7 Oct). All optional:
   * a visit must never be blocked by an unanswered survey question — the
   * customer is standing there either way. Free-text fields are length-capped;
   * the choice fields accept the form's own option list plus whatever an
   * "Other:" box produced, so they are strings with a cap rather than enums a
   * migration would have to chase.
   */
  @IsOptional()
  @IsIn(['new', 'existing'])
  customerType?: 'new' | 'existing';

  /** `YYYY-MM-DD`. Also written to the customer record, where occasions fire. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'birthday must be YYYY-MM-DD.' })
  birthday?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'anniversary must be YYYY-MM-DD.' })
  anniversary?: string;

  /** How they came to know about us — Word of Mouth, Social Media, Other:… */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  occasion?: string;

  /** Rings, Earrings, Mangalsutra… or the Other:… text. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  productCategory?: string;

  @IsOptional()
  @IsIn(['<50k', '50k-2L', '2-5L', '5-10L', '10-20L', '>20L', 'na'])
  budgetRange?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  nonPurchaseReason?: string;

  @IsOptional()
  @IsIn(['yes', 'no'])
  savingScheme?: 'yes' | 'no';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  savingSchemeReason?: string;
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
