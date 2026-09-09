import { IsDateString, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsRealName } from '../../common/contact.util';

export class CreateTaskDto {
  @IsString()
  @IsNotEmpty({ message: 'A task title is required' })
  @MaxLength(200)
  @IsRealName()
  title!: string;

  @IsOptional()
  @IsString()
  detail?: string;

  /** Mandatory (2026-08): a task must name who it is for. */
  @IsString()
  @IsNotEmpty({ message: 'An assignee is required' })
  @MaxLength(120)
  @IsRealName()
  assignee!: string;

  /**
   * The assignee's user id. Optional so an existing client that only sends a
   * name keeps working — but when present it is what the task is really
   * assigned to, and the name is taken from the user record rather than the
   * request.
   */
  @IsOptional()
  @IsString()
  assigneeId?: string;

  @IsOptional()
  @IsIn(['low', 'normal', 'high', 'urgent'])
  priority?: string;

  /** What this task is about. Verified against the caller's organisation. */
  @IsOptional()
  @IsString()
  partyId?: string;

  @IsOptional()
  @IsString()
  leadId?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  storeId?: string;
}

export class UpdateTaskStatusDto {
  @IsIn(['open', 'in_progress', 'done'])
  status!: string;
}

export class CreateHandoffDto {
  @IsOptional()
  @IsString()
  storeId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsRealName()
  fromDept!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsRealName()
  toDept!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @IsRealName()
  title!: string;

  @IsOptional()
  @IsString()
  note?: string;

  /** Free-text display name (legacy / fallback). */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @IsRealName()
  assignedTo?: string;

  /** The assignee's user id — who gets notified and owns "assigned to me". */
  @IsOptional()
  @IsString()
  assignedToId?: string;
}

export class UpdateHandoffStatusDto {
  @IsIn(['open', 'accepted', 'done', 'closed'])
  status!: string;
}
