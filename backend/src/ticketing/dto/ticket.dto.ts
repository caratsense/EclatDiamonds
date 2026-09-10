import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { TicketCategory, TicketPriority, TicketStatus } from '@prisma/client';
import { IsRealName } from '../../common/contact.util';

export class CreateTicketDto {
  @IsOptional()
  @IsString()
  storeId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @IsRealName()
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
  @MaxLength(120)
  @IsRealName()
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
  @MaxLength(120)
  @IsRealName()
  assigneeName?: string;
}

export class CreateTicketMessageDto {
  @IsString()
  @IsNotEmpty()
  body!: string;
}
