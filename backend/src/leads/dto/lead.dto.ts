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
  Min,
} from 'class-validator';
import { LeadSource, LeadStage } from '@prisma/client';

/** Follow-up reminder scopes for GET /leads/reminders. */
export const REMINDER_SCOPES = ['today', 'overdue', 'upcoming', 'pending', 'all'] as const;
export type ReminderScope = (typeof REMINDER_SCOPES)[number];

/** yyyy-mm-dd (date-only). */
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export class CreateLeadDto {
  @IsString()
  storeId!: string;

  @IsString()
  customerName!: string;

  /** Phone is mandatory on create (Round 2). */
  @IsString()
  @IsNotEmpty()
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

  @IsOptional()
  @IsString()
  interest?: string;

  @IsOptional()
  @IsString()
  ownerId?: string;

  /** Round 2: CRM contact detail (all optional). */
  @IsOptional()
  @IsString()
  address?: string;

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
