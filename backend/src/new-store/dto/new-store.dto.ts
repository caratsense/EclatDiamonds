import { IsDateString, IsOptional, IsString } from 'class-validator';

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
