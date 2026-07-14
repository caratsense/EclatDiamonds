import { IsDateString, IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';
import { ChecklistStatus, NewStoreDept } from '@prisma/client';

export class CreateProjectDto {
  @IsString()
  name!: string;

  @IsString()
  city!: string;

  @IsOptional()
  @IsDateString()
  launchDate?: string;

  @IsOptional()
  @IsString()
  leadName?: string;

  @IsOptional()
  @IsString()
  regionId?: string;
}

/** POST /new-store/projects/:id/checklist — add a checklist task to a launch. */
export class AddChecklistItemDto {
  @IsString()
  title!: string;

  /** Owning department; defaults to `inventory` when omitted. */
  @IsOptional()
  @IsEnum(NewStoreDept)
  dept?: NewStoreDept;

  @IsOptional()
  @IsEnum(ChecklistStatus)
  status?: ChecklistStatus;
}

/** PATCH /new-store/checklist/:id — move a task through todo → in_progress → done. */
export class UpdateChecklistItemDto {
  @IsOptional()
  @IsEnum(ChecklistStatus)
  status?: ChecklistStatus;

  @IsOptional()
  @IsString()
  title?: string;
}

/** POST /new-store/projects/:id/milestones — add a launch milestone. */
export class AddMilestoneDto {
  @IsString()
  title!: string;

  /** Milestone date (yyyy-mm-dd), stored on NewStoreMilestone.date. */
  @IsDateString()
  dueDate!: string;

  /** Phase marker, e.g. T-90 / T-60 / Launch (NewStoreMilestone.marker). */
  @IsOptional()
  @IsString()
  phase?: string;

  @IsOptional()
  @IsString()
  summary?: string;
}

/** PATCH /new-store/milestones/:id — update a milestone's state and/or date. */
export class UpdateMilestoneDto {
  /** Milestone state (NewStoreMilestone.state is free-text: upcoming/active/done). */
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;
}

/** POST /new-store/projects/:id/vendors — add a vendor engagement to a launch. */
export class AddVendorDto {
  @IsString()
  name!: string;

  /** What the vendor is doing (NewStoreVendor.task). */
  @IsString()
  scope!: string;

  @IsOptional()
  @IsString()
  status?: string;

  /** Quoted/contracted cost for this vendor (feeds project budget). */
  @IsOptional()
  @IsNumber()
  amount?: number;
}

/** PATCH /new-store/vendors/:id — update a vendor's status and/or amount. */
export class UpdateVendorDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsNumber()
  amount?: number;
}
