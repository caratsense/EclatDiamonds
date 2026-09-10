import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { ChecklistStatus, NewStoreDept } from '@prisma/client';
import { IsRealName } from '../../common/contact.util';

export class CreateProjectDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsRealName()
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsRealName()
  city!: string;

  @IsOptional()
  @IsDateString()
  launchDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @IsRealName()
  leadName?: string;

  @IsOptional()
  @IsString()
  regionId?: string;
}

/** POST /new-store/projects/:id/checklist — add a checklist task to a launch. */
export class AddChecklistItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @IsRealName()
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
  @MaxLength(200)
  @IsRealName()
  title?: string;
}

/** POST /new-store/projects/:id/milestones — add a launch milestone. */
export class AddMilestoneDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @IsRealName()
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
  @IsNotEmpty()
  @MaxLength(120)
  @IsRealName()
  name!: string;

  /** What the vendor is doing (NewStoreVendor.task). */
  @IsString()
  @IsNotEmpty()
  scope!: string;

  @IsOptional()
  @IsString()
  status?: string;

  /** Quoted/contracted cost for this vendor (feeds project budget). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;
}

/** PATCH /new-store/vendors/:id — update a vendor's status and/or amount. */
export class UpdateVendorDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;
}
