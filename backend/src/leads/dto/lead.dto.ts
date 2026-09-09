import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { LeadSource, LeadStage } from '@prisma/client';
import { IsIndianMobile, IsRealName } from '../../common/contact.util';

/** Follow-up reminder scopes for GET /leads/reminders. */
export const REMINDER_SCOPES = ['today', 'overdue', 'upcoming', 'pending', 'all'] as const;
export type ReminderScope = (typeof REMINDER_SCOPES)[number];

/** Activity kinds for POST /leads/:id/activities (stored on LeadNote.kind). */
export const NOTE_KINDS = ['note', 'call', 'visit', 'whatsapp'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** Lead closed-outcome values (Zoho-style won/lost tracking; string in DB). */
export const LEAD_OUTCOMES = ['open', 'won', 'lost'] as const;
export type LeadOutcome = (typeof LEAD_OUTCOMES)[number];

/** GET /leads ?outcome= — 'all' disables the default 'open' filter. */
export const LEAD_OUTCOME_FILTERS = [...LEAD_OUTCOMES, 'all'] as const;
export type LeadOutcomeFilter = (typeof LEAD_OUTCOME_FILTERS)[number];

/** yyyy-mm-dd (date-only). */
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export class CreateLeadDto {
  @IsString()
  @IsNotEmpty()
  storeId!: string;

  /**
   * A real name — required, and must contain at least one letter so a phone
   * number or reference id can never land in the name field (e.g. "46466").
   */
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  @IsRealName()
  customerName!: string;

  /** Phone is mandatory on create (Round 2) and must be a valid Indian mobile. */
  @IsString()
  @IsNotEmpty()
  @IsIndianMobile()
  phone!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  value?: number;

  @IsEnum(LeadSource)
  source!: LeadSource;

  @IsOptional()
  @IsEnum(LeadStage)
  stage?: LeadStage;

  /** What the lead wants — required so every lead is actionable. */
  @IsString()
  @IsNotEmpty({ message: 'Add what the lead is interested in.' })
  @MaxLength(280)
  interest!: string;

  @IsOptional()
  @IsString()
  ownerId?: string;

  /** Round 2: CRM contact detail (all optional). */
  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @Matches(YMD, { message: 'birthday must be yyyy-mm-dd' })
  birthday?: string;

  @IsOptional()
  @Matches(YMD, { message: 'anniversary must be yyyy-mm-dd' })
  anniversary?: string;

  /** Free-text remark; when present, seeded as the lead's first note. */
  @IsOptional()
  @IsString()
  remark?: string;
}

export class UpdateLeadDto {
  @IsOptional()
  @IsEnum(LeadStage)
  stage?: LeadStage;

  @IsOptional()
  @IsString()
  interest?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  value?: number;

  @IsOptional()
  @IsString()
  ownerId?: string;

  /** Round 2: CRM contact detail (all optional; phone stays optional on update). */
  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @Matches(YMD, { message: 'birthday must be yyyy-mm-dd' })
  birthday?: string;

  @IsOptional()
  @Matches(YMD, { message: 'anniversary must be yyyy-mm-dd' })
  anniversary?: string;
}

export class ListLeadsQuery {
  @IsOptional()
  @IsEnum(LeadStage)
  stage?: LeadStage;

  @IsOptional()
  @IsString()
  rep?: string;

  @IsOptional()
  @IsString()
  storeId?: string;

  /** Round 2: filter by createdAt date range (inclusive, yyyy-mm-dd). */
  @IsOptional()
  @Matches(YMD, { message: 'from must be yyyy-mm-dd' })
  from?: string;

  @IsOptional()
  @Matches(YMD, { message: 'to must be yyyy-mm-dd' })
  to?: string;

  /** Outcome filter; defaults to 'open' so the kanban shows only active leads. */
  @IsOptional()
  @IsIn(LEAD_OUTCOME_FILTERS)
  outcome?: LeadOutcomeFilter;
}

/** POST /leads/:id/activities body (Zoho-style logged activity → LeadNote). */
export class CreateActivityDto {
  @IsIn(NOTE_KINDS)
  kind!: NoteKind;

  @IsString()
  @IsNotEmpty()
  text!: string;
}

/** POST /leads/:id/follow-ups body (ad-hoc task with a due date). */
export class CreateFollowUpDto {
  @IsString()
  @Matches(YMD, { message: 'dueDate must be yyyy-mm-dd' })
  dueDate!: string;

  @IsOptional()
  @IsString()
  note?: string;
}

/** PATCH /leads/:id/outcome body ('lost' requires a non-empty lostReason). */
export class UpdateOutcomeDto {
  @IsIn(LEAD_OUTCOMES)
  outcome!: LeadOutcome;

  @IsOptional()
  @IsString()
  lostReason?: string;
}

/** PATCH /leads/reminders/:id body. */
export class UpdateFollowUpDto {
  /** Reschedule the follow-up (date-only, yyyy-mm-dd). */
  @IsOptional()
  @IsString()
  @Matches(YMD, { message: 'dueDate must be yyyy-mm-dd' })
  dueDate?: string;

  /** Mark the follow-up done (approve tick). */
  @IsOptional()
  @IsBoolean()
  done?: boolean;

  /** Optional note; on done=true it is appended to the lead as a LeadNote. */
  @IsOptional()
  @IsString()
  note?: string;
}

/** GET /leads/reminders query. */
export class ReminderQuery {
  @IsOptional()
  @IsIn(REMINDER_SCOPES)
  scope?: ReminderScope;
}
