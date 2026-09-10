/**
 * Industry pack definitions (CaratOS Phase A2).
 *
 * A pack is a versioned, code-defined starting vocabulary for one industry. It
 * is APPLIED to a tenant, which materialises TaxonomyTerm / AttributeDefinition
 * / FieldPolicy rows the tenant then owns and may edit. The pack is never read
 * at request time — only at apply/upgrade — so a tenant's live behaviour depends
 * on its own rows, not on whatever the current release happens to ship.
 *
 * Packs deliberately live in git rather than in a table: a definition stored in
 * the database needs its own editor and its own migrations to ship, and would
 * become the dead configuration system this layer exists to replace.
 */

export type AttributeDataType =
  | 'text'
  | 'number'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'enum'
  | 'multi_enum';

/** Which entity's JSONB `attributes` column a custom field is stored in. */
export type ConfigurableEntity = 'product' | 'party' | 'lead';

export interface PackTerm {
  code: string;
  label: string;
  /**
   * The core Prisma enum value this term shadows, when the concept already has a
   * typed column (e.g. 'walk_in' for LeadSource). Set ONLY where the enum value
   * genuinely exists — a mismatch here would let the UI offer a value the
   * database rejects.
   */
  systemValue?: string;
  /** Parent term's `code` within the same vocabulary, for hierarchies. */
  parentCode?: string;
  sortOrder?: number;
  metadata?: Record<string, unknown>;
}

export interface PackTaxonomy {
  /** Vocabulary key, e.g. 'product_category'. Unique within a pack. */
  kind: string;
  /** Human name for the vocabulary itself, shown in admin settings. */
  label: string;
  /**
   * True when the vocabulary shadows a closed Prisma enum. Terms in a
   * system-backed vocabulary may be relabelled or hidden by the tenant, but new
   * terms cannot be persisted to the typed column — the UI must say so rather
   * than letting a user create a value that will fail to save.
   */
  systemBacked?: boolean;
  terms: PackTerm[];
}

export interface PackAttribute {
  entity: ConfigurableEntity;
  key: string;
  label: string;
  dataType: AttributeDataType;
  required?: boolean;
  /** For enum/multi_enum: the vocabulary supplying options. */
  taxonomyKind?: string;
  /** Static options, when a whole vocabulary would be overkill. */
  options?: string[];
  unit?: string;
  searchable?: boolean;
  sortOrder?: number;
}

export interface PackFieldPolicy {
  entity: string;
  field: string;
  requirement: 'hidden' | 'optional' | 'required';
  label?: string;
}

export interface PackPipelineStage {
  code: string;
  label: string;
  sortOrder: number;
  outcome: 'open' | 'won' | 'lost';
  /** Bridge to the legacy LeadStage enum used by existing reports. */
  systemValue?: 'inquiry' | 'quotation' | 'order_placed';
  probability?: number;
}

/**
 * The canonical nouns a business puts on its own screens.
 *
 * ## Why nouns and not screen labels
 *
 * The keys below are the CONCEPTS the product is built out of. Core logic keeps
 * using them under these names forever — a lead is a `Lead` row, a customer is a
 * `Party`, regardless of what the tenant's staff call them. A pack supplies only
 * the WORDS, and the words are resolved at render time. Nothing branches on an
 * industry, and no industry gets a column of its own.
 *
 * ## Why a pack may leave this out entirely
 *
 * An absent lexicon means "the neutral wording is already right". Jewellery
 * deliberately declares none: Eclat's screens say Customer, Lead, Product,
 * Catalogue, Store and Check-in today, and those are exactly the neutral
 * defaults, so the live vertical produces an EMPTY override map and cannot
 * drift. A pack should override a key only where a practitioner in that trade
 * would genuinely use a different word — an override that just restates the
 * default is noise that has to be maintained.
 */
export type LexiconKey =
  | 'customer'
  | 'customer_plural'
  | 'lead'
  | 'lead_plural'
  | 'product'
  | 'product_plural'
  | 'catalogue'
  | 'store'
  | 'store_plural';

export type PackLexicon = Partial<Record<LexiconKey, string>>;

export interface PackOnboardingProfile {
  /** Navigation routes recommended for a fresh tenant in this industry. */
  enabledNavigation: string[];
  /** Context stored for the provider-neutral CRM assistant and qualification UI. */
  aiCrmContext: string;
  qualificationFields: string[];
  pipeline: {
    code: string;
    name: string;
    stages: PackPipelineStage[];
  };
}

export interface IndustryPack {
  code: string;
  name: string;
  /**
   * Bumped when the pack's contents change. Applying a newer version adds and
   * updates PACK-OWNED rows (packCode set) only; anything the tenant created or
   * renamed is left alone.
   */
  version: number;
  description: string;
  taxonomies: PackTaxonomy[];
  attributes: PackAttribute[];
  fieldPolicies: PackFieldPolicy[];
  /**
   * What this industry calls the core concepts. Omit entirely when the neutral
   * wording is already correct — see PackLexicon.
   *
   * DO NOT bump `version` when you change this. `version` exists so a tenant can
   * be told "re-apply to receive what you are missing", and it compares against
   * the rows provisioning WROTE. A lexicon is never written: it is resolved from
   * the pack on every bootstrap, so a change here is already in effect for every
   * tenant on this pack the moment it deploys. Bumping would raise an upgrade
   * badge whose only honest description is "re-apply to add nothing".
   */
  lexicon?: PackLexicon;
  /** Fresh-tenant defaults. Applying a pack to an existing tenant remains additive. */
  onboarding?: PackOnboardingProfile;
}
