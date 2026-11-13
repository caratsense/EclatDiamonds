import { LOCAL_DATETIME } from '../../crm/follow-up-reminders.service';
import {
  IsBoolean,
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
import { IsCustomerPhone, IsRealName } from '../../common/contact.util';

export class CreateCheckInDto {
  @IsString()
  @IsNotEmpty()
  storeId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsRealName()
  customerName!: string;

  /**
   * REQUIRED since the walk-in review (Nov 2026). The client's register marks
   * it mandatory, and the reason is downstream: a visit with no number cannot
   * be followed up, cannot be sent an NPS request and cannot be matched to the
   * customer when they return — so the row is of no use to anyone.
   *
   * Walk-ins may be foreign customers (client, 13 Oct): Indian or international.
   */
  @IsString()
  @IsNotEmpty()
  @IsCustomerPhone()
  phone!: string;

  @IsOptional()
  @IsEnum(CheckinPurpose)
  purpose?: CheckinPurpose;

  /**
   * The day being reported on, `YYYY-MM-DD`. The register is often written up
   * after the fact, which is why the form asks for a date at all rather than
   * stamping the moment of entry — `timeIn` still records that.
   */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'visitDate must be YYYY-MM-DD.' })
  visitDate?: string;

  /** The manager on the floor — a second person from "Sales Person Name". */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  managerName?: string;

  /** Mandatory on the form; optional here so an older client can still post. */
  @IsOptional()
  @IsBoolean()
  googleReviewTaken?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  referralName?: string;

  @IsOptional()
  @IsString()
  @IsCustomerPhone()
  referralPhone?: string;

  /** What this branch needs FROM head office, not what it will do itself. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  recommendedAction?: string;

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

  /*
   * The client's register buckets, verbatim. Ours were coarser at the bottom
   * (`<50k` covered three of theirs) so a reported figure could not be mapped
   * back without losing the distinction head office actually sorts on.
   */
  @IsOptional()
  @IsIn(['<25k', '25k-50k', '50k-1L', '1-2L', '2-5L', '5-10L', '10>', 'na'])
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

/** PUT /checkins/settings — what the Check-ins screen shows. */
export class CheckinSettingsDto {
  /** Show who is in the store right now. Off for a shop that logs a visit after serving. */
  @IsBoolean()
  liveOccupancy!: boolean;
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
   * When the piece reaches the customer, `YYYY-MM-DD`. Only a custom order has
   * one — a direct sale leaves the counter with the customer — so the service
   * refuses it on any other outcome rather than storing a date nothing means.
   */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'deliveryDate must be YYYY-MM-DD.' })
  deliveryDate?: string;

  /**
   * When the employee is reminded, `YYYY-MM-DDTHH:MM` in the store's timezone.
   * Independent of the follow-up date: omitted, the tenant's default applies;
   * sent alone, the follow-up is due on the reminder's day.
   */
  @IsOptional()
  @Matches(LOCAL_DATETIME, { message: 'reminderAt must be YYYY-MM-DDTHH:MM.' })
  reminderAt?: string;
}
