import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Configuration DTOs (CaratOS Phase A2).
 *
 * NOTE what is absent from every class here: `organisationId`. The tenant is
 * resolved from the authenticated user in the service, so a client cannot name
 * the organisation it wants to configure even by accident. Adding that field
 * back would reintroduce exactly the vulnerability Phase B2 has to test for.
 */

/**
 * Vocabulary and attribute keys are used as object keys and in URLs, so they are
 * restricted to a slug shape. This is not cosmetic: `key` addresses a property
 * inside a JSONB document, and an unconstrained string there invites both
 * collisions and awkward escaping downstream.
 */
const SLUG = /^[a-z0-9][a-z0-9_]*$/;
const SLUG_MESSAGE = 'must be lowercase letters, digits and underscores, starting with a letter or digit';

export class ApplyPackDto {
  @IsString()
  @Matches(SLUG, { message: `packCode ${SLUG_MESSAGE}` })
  @MaxLength(50)
  packCode!: string;
}

export class CreateTermDto {
  @IsString()
  @Matches(SLUG, { message: `kind ${SLUG_MESSAGE}` })
  @MaxLength(50)
  kind!: string;

  @IsString()
  @Matches(SLUG, { message: `code ${SLUG_MESSAGE}` })
  @MaxLength(80)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;

  @IsOptional()
  @IsString()
  parentId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;

  /**
   * Only accepted when an existing term in the same vocabulary already maps to
   * it — see TenantConfigService.resolveSystemValue. Left blank, the term is a
   * label-only value.
   */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  systemValue?: string;
}

export class UpdateTermDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpsertAttributeDto {
  @IsString()
  @IsIn(['product', 'party', 'lead'])
  entity!: string;

  @IsString()
  @Matches(SLUG, { message: `key ${SLUG_MESSAGE}` })
  @MaxLength(60)
  key!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;

  @IsString()
  @IsIn(['text', 'number', 'decimal', 'boolean', 'date', 'enum', 'multi_enum'])
  dataType!: string;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsString()
  @Matches(SLUG, { message: `taxonomyKind ${SLUG_MESSAGE}` })
  @MaxLength(50)
  taxonomyKind?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  options?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

  @IsOptional()
  @IsBoolean()
  searchable?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

export class UpsertFieldPolicyDto {
  @IsString()
  @MaxLength(50)
  entity!: string;

  @IsString()
  @MaxLength(80)
  field!: string;

  @IsString()
  @IsIn(['hidden', 'optional', 'required'])
  requirement!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

/**
 * PUT /config/capabilities — the complete list of modules to keep switched off.
 *
 * The WHOLE list, not a delta. A delta ("turn this one off") reads more nicely
 * and loses to the last writer: two administrators on two screens each send
 * their own change and the second silently restores whatever the first removed.
 * Sending the full intended state makes the outcome the same whichever order
 * they arrive in, and lets the screen show exactly what it is about to save.
 */
export class SetCapabilitiesDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  disabled!: string[];
}
