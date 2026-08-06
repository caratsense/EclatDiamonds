import { IsDateString, IsIn, IsOptional, IsString } from 'class-validator';

export class CreateTaskDto {
  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  detail?: string;

  @IsOptional()
  @IsString()
  assignee?: string;

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
  fromDept!: string;

  @IsString()
  toDept!: string;

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  note?: string;

  /** Free-text display name (legacy / fallback). */
  @IsOptional()
  @IsString()
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
