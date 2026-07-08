import { IsEnum, IsOptional, IsString } from 'class-validator';
import { TicketCategory, TicketPriority, TicketStatus } from '@prisma/client';

export class CreateTicketDto {
  @IsOptional()
  @IsString()
  storeId?: string;

  @IsString()
  subject!: string;

  /** Optional (Round 2): omitted tickets route to the general Back Office bucket. */
  @IsOptional()
  @IsEnum(TicketCategory)
  category?: TicketCategory;

  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority;

  @IsOptional()
  @IsString()
  reporterName?: string;

  @IsOptional()
  @IsString()
  patternTag?: string;
}

export class UpdateTicketDto {
  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority;

  @IsOptional()
  @IsString()
  assigneeId?: string;

  @IsOptional()
  @IsString()
  assigneeName?: string;
}

export class CreateTicketMessageDto {
  @IsString()
  body!: string;
}
