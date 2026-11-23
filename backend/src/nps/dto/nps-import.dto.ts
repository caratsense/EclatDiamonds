import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * POST /crm/nps/import.
 *
 * The sheet itself travels as the multipart `file`; these two fields exist
 * because the tab names belong to the client, not to us. The defaults are what
 * her workbook is called today ("NPS Responses", "Followup answers"), and a
 * rename must be something she can work around from the screen rather than a
 * reason to wait for a deployment.
 */
export class NpsImportDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  responsesSheet?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  followupsSheet?: string;
}
