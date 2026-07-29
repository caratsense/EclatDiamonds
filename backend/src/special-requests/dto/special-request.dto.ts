import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  SpecialRequestKind,
  SpecialRequestStatus,
  TicketPriority,
} from '@prisma/client';

/** POST /requests — a branch raises a request to someone above it. */
export class CreateSpecialRequestDto {
  @IsString()
  storeId!: string;

  @IsEnum(SpecialRequestKind)
  kind!: SpecialRequestKind;

  @IsString()
  @MinLength(3)
  @MaxLength(160)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  details?: string;

  /** Value at stake (INR). Feeds the escalation ladder — a bigger ask goes higher. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount?: number;

  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority;

  /** Date the branch needs an answer by (YYYY-MM-DD). Drives the overdue flag. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'neededBy must be YYYY-MM-DD' })
  neededBy?: string;

  // --- diamond_rate payload (required when kind is diamond_rate) -------------

  /** Diamond spec/code the rate applies to; matches DiamondRate.spec. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  diamondSpec?: string;

  /** The per-carat rate the branch is asking for. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  requestedRatePerCarat?: number;
}

/** PATCH /requests/:id/decide — approve or reject. */
export class DecideSpecialRequestDto {
  @IsIn([SpecialRequestStatus.approved, SpecialRequestStatus.rejected])
  status!: 'approved' | 'rejected';

  /** Rationale recorded on the request and shown back to the branch. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  /**
   * Diamond-rate approvals only: approve at a DIFFERENT rate than the one asked
   * for. Omitted means "approve exactly what was requested". This is the common
   * real outcome — HO meets the branch partway rather than a flat yes/no.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  approvedRatePerCarat?: number;
}

/** PATCH /requests/:id/escalate — push it up a rung. */
export class EscalateSpecialRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** PATCH /requests/:id/cancel — the branch withdraws it. */
export class CancelSpecialRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** POST /requests/:id/messages — add to the thread. */
export class AddRequestMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;
}

/** GET /requests — filters. */
export class ListSpecialRequestsQueryDto {
  /**
   * `inbox`  — undecided requests THIS user can act on (the approver queue).
   * `mine`   — requests the caller raised.
   * `open`   — every undecided request in scope.
   * `all`    — everything in scope, decided included.
   */
  @IsOptional()
  @IsIn(['inbox', 'mine', 'open', 'all'])
  scope?: 'inbox' | 'mine' | 'open' | 'all';

  @IsOptional()
  @IsEnum(SpecialRequestKind)
  kind?: SpecialRequestKind;

  @IsOptional()
  @IsEnum(SpecialRequestStatus)
  status?: SpecialRequestStatus;
}
