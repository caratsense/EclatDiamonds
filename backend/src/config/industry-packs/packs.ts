import type { IndustryPack, PackLexicon, PackTaxonomy, PackTerm } from './types';

/**
 * The shipped industry packs.
 *
 * HONESTY RULE for pack contents: a seeded term is a STARTING vocabulary the
 * tenant edits, so ordinary trade vocabulary (dosage forms, fabrics) is fine to
 * seed. Anything regulated, tenant-specific or jurisdictional — therapeutic
 * classifications, HSN codes, statutory categories — is left as an empty
 * vocabulary for the tenant to populate. Seeding a plausible-looking list there
 * would be fabrication dressed up as a default.
 */

/**
 * Where a lead came from. Universal across every industry, and it shadows the
 * existing `LeadSource` enum — so `systemValue` is set on every term and the
 * vocabulary is marked systemBacked. A tenant may relabel or hide these; adding
 * a seventh source needs the enum widened first.
 */
const LEAD_SOURCE: PackTaxonomy = {
  kind: 'lead_source',
  label: 'Lead source',
  systemBacked: true,
  terms: [
    { code: 'walk_in', label: 'Walk-in', systemValue: 'walk_in', sortOrder: 1 },
    { code: 'phone', label: 'Phone', systemValue: 'phone', sortOrder: 2 },
    { code: 'whatsapp', label: 'WhatsApp', systemValue: 'whatsapp', sortOrder: 3 },
    { code: 'website', label: 'Website', systemValue: 'website', sortOrder: 4 },
    { code: 'instagram', label: 'Instagram', systemValue: 'instagram', sortOrder: 5 },
    { code: 'referral', label: 'Referral', systemValue: 'referral', sortOrder: 6 },
    // Paid lead forms on Facebook or Instagram. Distinct from `instagram`,
    // which is the organic channel: a Facebook lead form is neither Instagram
    // nor a website, and filing it under either corrupts every source-mix
    // report. Every pack shares this constant, so adding it here mirrors it
    // into all sixteen industries at once.
    { code: 'meta_ads', label: 'Meta Ads', systemValue: 'meta_ads', sortOrder: 7 },
  ],
};

/** Why a customer visited. Shadows `CheckinPurpose`; retail-shaped but generic. */
function checkinPurpose(terms: PackTerm[]): PackTaxonomy {
  return { kind: 'checkin_purpose', label: 'Visit purpose', systemBacked: true, terms };
}

/**
 * The jewellery-only product inputs. A non-jewellery pack hides these rather
 * than dropping the columns: Eclat keeps working, and a pharmacist never sees an
 * empty karat box. Listed once because all three non-jewellery packs hide the
 * same set.
 */
const HIDE_JEWELLERY_PRODUCT_FIELDS: IndustryPack['fieldPolicies'] = [
  /*
   * `metal` was missing from this list, and it is the one that mattered most.
   *
   * The other five hide inputs. This one hides an input whose value is REQUIRED
   * and defaulted to `gold_22k`, so a pharmacy's every product was not merely
   * displayed as gold — it was stored as gold. Hiding the control is what lets
   * the form send the neutral `unspecified` member instead.
   */
  { entity: 'product', field: 'metal', requirement: 'hidden' },
  { entity: 'product', field: 'purity', requirement: 'hidden' },
  { entity: 'product', field: 'grossWeight', requirement: 'hidden' },
  { entity: 'product', field: 'netWeight', requirement: 'hidden' },
  { entity: 'product', field: 'makingChargeType', requirement: 'hidden' },
  { entity: 'product', field: 'huid', requirement: 'hidden' },
];

/**
 * The typed column behind product_category is the closed `ProductCategory` enum,
 * whose only industry-neutral member is `other`. A non-jewellery tenant's real
 * categories are tenant-created terms that map to `other` at the column and
 * carry their own label in the UI.
 */
const NEUTRAL_PRODUCT_CATEGORY: PackTaxonomy = {
  kind: 'product_category',
  label: 'Product category',
  systemBacked: true,
  terms: [{ code: 'other', label: 'Uncategorised', systemValue: 'other', sortOrder: 1 }],
};

/**
 * The independently sellable CaratOS suite. New non-jewellery organisations get
 * only these modules: AI CRM, AI-ready cataloguing, attendance, and the admin/data
 * surfaces required to operate them. The wider operational ERP remains Eclat's
 * jewellery product until a future vertical is explicitly designed and verified.
 */
const CORE_NAVIGATION = [
  'crm',
  'conversations',
  'customers',
  'reminders',
  'catalogue',
  /*
   * Customer visits are universal, not a jewellery habit.
   *
   * Every pack in this file already seeds a `checkin_purpose` vocabulary with
   * its own visit labels — "Appointment / consultation" for a clinic, "Site
   * visit" for a developer. Seeding a vocabulary for a screen the tenant could
   * not open was the tell that this belonged here all along.
   */
  'checkins',
  'hrms',
  /*
   * Campaigns are universal, and deliberately NOT the same capability as
   * `marketing`.
   *
   * `marketing` is Eclat's agency-planning module: briefs, budgets, deliverables,
   * and a `CampaignType` enum that reads bridal/festive. Reaching customers on
   * WhatsApp is something a clinic, a mill and a dealership all do, and gating it
   * behind the jewellery module would have meant every other tenant either lost
   * outreach entirely or had to claim it was running a bridal campaign.
   */
  'campaigns',
  /*
   * The website enquiry form. Universal for the same reason as campaigns: every
   * industry has a website, and the form files into the same CRM pipeline every
   * other lead door uses. It had no navigation slug at all until now, which is
   * why the screen existed but could not be reached from the sidebar.
   */
  'lead-forms',
  /*
   * The floor/field app. Universal: a clinic reception, a plant visitor desk and
   * a showroom counter are the same workflow — find the person, see what they
   * came for, record what happened.
   */
  'instore',
  /* Chasing a follow-up is what every CRM is for. */
  'calling',
  /* Asking how it went, and keeping an unhappy answer off a public review page. */
  'feedback',
  /*
   * The screens below were BUILT AND UNREACHABLE.
   *
   * Each has shipped, been tested and been deployed, and then could only be
   * opened by somebody typing its address — because this list is the
   * entitlement AND the navigation, and a slug missing from it means both "not
   * in the sidebar" and "403 from the API". A feature nobody can find is a
   * feature nobody uses, whatever the release notes say.
   *
   * Every one of them is universal. Archiving a contact, measuring how long a
   * customer waited, chasing a task, running the payroll the attendance
   * register implies, labelling a lead, matching photographs to products,
   * choosing which number a branch answers on, and seeing which channels
   * actually work — a clinic, a mill and a dealership each need all of them.
   */
  'customers/archived',
  'conversations/sla',
  'tasks',
  'hrms/payroll',
  'settings/staff-digest',
  'settings/lead-tags',
  'settings/messaging-routes',
  'settings/channels',
  'data/images',
  'settings/onboarding',
  'settings/stores',
  'settings/team',
  'settings/configuration',
  'data',
  'settings/integrations',
  'settings/audit',
  /** Head office decides, person by person, which screens someone can open. */
  'settings/access',
] as const;

function universalNavigation(): string[] {
  return [...CORE_NAVIGATION];
}

/** Eclat keeps its existing jewellery operations in addition to the suite. */
function eclatNavigation(...additional: string[]): string[] {
  return [
    ...new Set([
      ...CORE_NAVIGATION,
      'dashboards',
      'reporting',
      /*
       * The cross-branch management view and the reports that send themselves.
       *
       * Grouped with `dashboards` and `reporting` rather than put in the
       * universal spine, because both answer a MULTI-BRANCH question. A
       * single-location tenant on the universal suite has nothing to compare
       * and nobody to send a month-end file to, so giving them the screen would
       * be giving them an empty one.
       */
      'management',
      'reporting/scheduled',
      'marketing',
      'ticketing',
      ...additional,
    ]),
  ];
}

function pipeline(
  name: string,
  labels: [string, string, string],
): NonNullable<IndustryPack['onboarding']>['pipeline'] {
  return {
    code: 'default',
    name,
    stages: [
      {
        code: 'inquiry',
        label: labels[0],
        sortOrder: 1,
        outcome: 'open',
        systemValue: 'inquiry',
        probability: 20,
      },
      {
        code: 'quotation',
        label: labels[1],
        sortOrder: 2,
        outcome: 'open',
        systemValue: 'quotation',
        probability: 50,
      },
      {
        code: 'order_placed',
        label: labels[2],
        sortOrder: 3,
        outcome: 'won',
        systemValue: 'order_placed',
        probability: 100,
      },
    ],
  };
}

function servicePack(input: {
  code: string;
  name: string;
  description: string;
  aiCrmContext: string;
  qualificationFields: string[];
  pipelineName: string;
  pipelineLabels: [string, string, string];
  attributes: IndustryPack['attributes'];
  visitLabels?: [string, string];
  /** Only the nouns this trade genuinely says differently. Omit the rest. */
  lexicon?: PackLexicon;
}): IndustryPack {
  const visitLabels = input.visitLabels ?? ['Consultation / enquiry', 'Follow-up'];
  return {
    code: input.code,
    name: input.name,
    version: 2,
    description: input.description,
    taxonomies: [
      LEAD_SOURCE,
      NEUTRAL_PRODUCT_CATEGORY,
      checkinPurpose([
        { code: 'browsing', label: visitLabels[0], systemValue: 'browsing', sortOrder: 1 },
        {
          code: 'quote_followup',
          label: visitLabels[1],
          systemValue: 'quote_followup',
          sortOrder: 2,
        },
        { code: 'other', label: 'Other', systemValue: 'other', sortOrder: 3 },
      ]),
    ],
    attributes: input.attributes,
    fieldPolicies: HIDE_JEWELLERY_PRODUCT_FIELDS,
    ...(input.lexicon ? { lexicon: input.lexicon } : {}),
    onboarding: {
      /*
       * ALWAYS exactly the universal suite — there is deliberately no per-pack
       * way to widen it.
       *
       * This function used to accept an `additionalNavigation` list, and every
       * caller passed one (finance, inventory, returns, targets …). None of it
       * was ever read: the field was declared, populated twelve times, and
       * silently dropped here. The parameter has been removed rather than
       * honoured, because honouring it is the wrong behaviour — those screens
       * are Eclat's jewellery operations, and pointing a clinic or a factory at
       * them would expose workflows this product has not built for them merely
       * because the tables exist. A pack earns a screen by that screen being
       * designed for it, not by listing its route here.
       */
      enabledNavigation: universalNavigation(),
      aiCrmContext: input.aiCrmContext,
      qualificationFields: input.qualificationFields,
      pipeline: pipeline(input.pipelineName, input.pipelineLabels),
    },
  };
}

// ---------------------------------------------------------------------------
// JEWELLERY — Eclat / organisation #1.
//
// Every term below mirrors a value that already exists in schema.prisma today.
// This pack does not introduce jewellery vocabulary; it DESCRIBES the vocabulary
// the running system already has, so the same UI that renders a pharmacy's
// fields can render Eclat's without special-casing jewellery.
// ---------------------------------------------------------------------------
const JEWELLERY: IndustryPack = {
  code: 'jewellery',
  name: 'Jewellery retail',
  version: 1,
  description:
    'Gold, diamond and precious-stone retail: karat/metal purity, per-piece weight, ' +
    'making charges and hallmarking. Mirrors the enums Eclat already runs on.',
  taxonomies: [
    LEAD_SOURCE,
    {
      kind: 'product_category',
      label: 'Product category',
      systemBacked: true,
      terms: [
        { code: 'necklace', label: 'Necklace', systemValue: 'necklace', sortOrder: 1 },
        { code: 'ring', label: 'Ring', systemValue: 'ring', sortOrder: 2 },
        { code: 'earrings', label: 'Earrings', systemValue: 'earrings', sortOrder: 3 },
        { code: 'bangle', label: 'Bangle', systemValue: 'bangle', sortOrder: 4 },
        { code: 'bracelet', label: 'Bracelet', systemValue: 'bracelet', sortOrder: 5 },
        { code: 'pendant', label: 'Pendant', systemValue: 'pendant', sortOrder: 6 },
        { code: 'chain', label: 'Chain', systemValue: 'chain', sortOrder: 7 },
        { code: 'other', label: 'Other', systemValue: 'other', sortOrder: 8 },
      ],
    },
    {
      kind: 'metal',
      label: 'Metal / purity',
      systemBacked: true,
      terms: [
        { code: 'gold_24k', label: '24K Gold', systemValue: 'gold_24k', sortOrder: 1 },
        { code: 'gold_22k', label: '22K Gold', systemValue: 'gold_22k', sortOrder: 2 },
        { code: 'gold_18k', label: '18K Gold', systemValue: 'gold_18k', sortOrder: 3 },
        { code: 'gold_14k', label: '14K Gold', systemValue: 'gold_14k', sortOrder: 4 },
        { code: 'gold_10k', label: '10K Gold', systemValue: 'gold_10k', sortOrder: 5 },
        { code: 'gold_9k', label: '9K Gold', systemValue: 'gold_9k', sortOrder: 6 },
        { code: 'rose_gold_18k', label: '18K Rose Gold', systemValue: 'rose_gold_18k', sortOrder: 7 },
        { code: 'platinum', label: 'Platinum', systemValue: 'platinum', sortOrder: 8 },
        { code: 'silver', label: 'Silver', systemValue: 'silver', sortOrder: 9 },
        {
          code: 'gold_unspecified',
          label: 'Gold (purity unknown)',
          systemValue: 'gold_unspecified',
          sortOrder: 10,
          metadata: { note: 'Karat could not be read from the source record.' },
        },
      ],
    },
    checkinPurpose([
      { code: 'bridal', label: 'Bridal', systemValue: 'bridal', sortOrder: 1 },
      { code: 'investment', label: 'Investment', systemValue: 'investment', sortOrder: 2 },
      { code: 'repair', label: 'Repair', systemValue: 'repair', sortOrder: 3 },
      { code: 'quote_followup', label: 'Quote follow-up', systemValue: 'quote_followup', sortOrder: 4 },
      { code: 'browsing', label: 'Browsing', systemValue: 'browsing', sortOrder: 5 },
      { code: 'scheme', label: 'Savings scheme', systemValue: 'scheme', sortOrder: 6 },
      { code: 'other', label: 'Other', systemValue: 'other', sortOrder: 7 },
    ]),
  ],
  // Jewellery's core measurements are REAL COLUMNS on Product/StockItem already
  // (grossWeight, netWeight, purity, huid …). They are deliberately not
  // re-declared as custom attributes — that would create two homes for one
  // value. Only genuinely optional merchandising detail lives here.
  attributes: [
    { entity: 'product', key: 'occasion', label: 'Occasion', dataType: 'text', searchable: true, sortOrder: 1 },
    { entity: 'product', key: 'collection', label: 'Collection', dataType: 'text', searchable: true, sortOrder: 2 },
    {
      entity: 'party',
      key: 'preferred_metal',
      label: 'Preferred metal',
      dataType: 'enum',
      taxonomyKind: 'metal',
      sortOrder: 1,
    },
  ],
  fieldPolicies: [],
  onboarding: {
    enabledNavigation: eclatNavigation(
      'activity',
      'store-comparison',
      'quotation',
      'returns',
      'discounts',
      'loyalty',
      'loyalty/programme',
      'sales-performance',
      'inventory',
      'inventory/dead-stock',
      'stock-transfers',
      'payments',
      'finance',
      'new-store',
      'approvals',
      'requests',
      'settings/rates',
      'settings/targets',
    ),
    aiCrmContext:
      'Jewellery retail enquiries, appointments, preferences, quotations and purchase follow-ups.',
    qualificationFields: ['occasion', 'budget', 'preferred_metal', 'purchase_timeline'],
    pipeline: pipeline('Jewellery sales pipeline', ['Enquiry', 'Quotation', 'Order placed']),
  },
};

// ---------------------------------------------------------------------------
// GENERAL RETAIL — the industry-neutral baseline, and the safe pack for a
// business that does not match a specialised one.
// ---------------------------------------------------------------------------
const RETAIL: IndustryPack = {
  code: 'retail',
  name: 'Retail & e-commerce',
  version: 2,
  description:
    'Industry-neutral baseline: products, stock, customers and sales with no ' +
    'domain-specific measurements. The right starting point when no specialised pack fits.',
  taxonomies: [
    LEAD_SOURCE,
    NEUTRAL_PRODUCT_CATEGORY,
    checkinPurpose([
      { code: 'browsing', label: 'Browsing', systemValue: 'browsing', sortOrder: 1 },
      { code: 'quote_followup', label: 'Order follow-up', systemValue: 'quote_followup', sortOrder: 2 },
      { code: 'repair', label: 'Service / repair', systemValue: 'repair', sortOrder: 3 },
      { code: 'other', label: 'Other', systemValue: 'other', sortOrder: 4 },
    ]),
    { kind: 'brand', label: 'Brand', terms: [] },
  ],
  attributes: [
    {
      entity: 'product',
      key: 'brand',
      label: 'Brand',
      dataType: 'enum',
      taxonomyKind: 'brand',
      searchable: true,
      sortOrder: 1,
    },
  ],
  fieldPolicies: HIDE_JEWELLERY_PRODUCT_FIELDS,
  onboarding: {
    enabledNavigation: universalNavigation(),
    aiCrmContext:
      'Retail and e-commerce enquiries, product discovery, quotations, orders and repeat purchases.',
    qualificationFields: ['product_interest', 'budget', 'quantity', 'purchase_timeline'],
    pipeline: pipeline('Retail sales pipeline', ['Enquiry', 'Offer / cart', 'Order confirmed']),
  },
};

// ---------------------------------------------------------------------------
// PHARMACY
//
// Dosage forms are ordinary trade vocabulary and are seeded. `medicine_category`
// (therapeutic classification) is left EMPTY on purpose — it is regulated and
// varies by jurisdiction, so a seeded guess would be fabrication.
// ---------------------------------------------------------------------------
const PHARMACY: IndustryPack = {
  code: 'pharmacy',
  name: 'Pharmacy',
  version: 2,
  description:
    'Retail pharmacy: manufacturer, composition, strength, dosage form and pack size. ' +
    'Therapeutic categories are left for the tenant to define.',
  taxonomies: [
    LEAD_SOURCE,
    NEUTRAL_PRODUCT_CATEGORY,
    {
      kind: 'dosage_form',
      label: 'Dosage form',
      terms: [
        { code: 'tablet', label: 'Tablet', sortOrder: 1 },
        { code: 'capsule', label: 'Capsule', sortOrder: 2 },
        { code: 'syrup', label: 'Syrup', sortOrder: 3 },
        { code: 'injection', label: 'Injection', sortOrder: 4 },
        { code: 'ointment', label: 'Ointment / cream', sortOrder: 5 },
        { code: 'drops', label: 'Drops', sortOrder: 6 },
        { code: 'inhaler', label: 'Inhaler', sortOrder: 7 },
        { code: 'other', label: 'Other', sortOrder: 8 },
      ],
    },
    { kind: 'manufacturer', label: 'Manufacturer', terms: [] },
    // Intentionally empty — see the honesty rule at the top of this file.
    { kind: 'medicine_category', label: 'Therapeutic category', terms: [] },
    checkinPurpose([
      { code: 'browsing', label: 'Purchase', systemValue: 'browsing', sortOrder: 1 },
      {
        code: 'quote_followup',
        label: 'Prescription follow-up',
        systemValue: 'quote_followup',
        sortOrder: 2,
      },
      { code: 'other', label: 'Other', systemValue: 'other', sortOrder: 3 },
    ]),
  ],
  attributes: [
    {
      entity: 'product',
      key: 'manufacturer',
      label: 'Manufacturer',
      dataType: 'enum',
      taxonomyKind: 'manufacturer',
      searchable: true,
      sortOrder: 1,
    },
    { entity: 'product', key: 'composition', label: 'Composition', dataType: 'text', searchable: true, sortOrder: 2 },
    { entity: 'product', key: 'strength', label: 'Strength', dataType: 'text', unit: 'mg', sortOrder: 3 },
    {
      entity: 'product',
      key: 'dosage_form',
      label: 'Dosage form',
      dataType: 'enum',
      taxonomyKind: 'dosage_form',
      searchable: true,
      sortOrder: 4,
    },
    {
      entity: 'product',
      key: 'medicine_category',
      label: 'Therapeutic category',
      dataType: 'enum',
      taxonomyKind: 'medicine_category',
      searchable: true,
      sortOrder: 5,
    },
    { entity: 'product', key: 'pack_size', label: 'Pack size', dataType: 'text', sortOrder: 6 },
  ],
  fieldPolicies: HIDE_JEWELLERY_PRODUCT_FIELDS,
  // A chemist's walk-in is a customer, not a patient: this pack stores no
  // clinical record and must not imply one. Only the enquiry noun differs.
  lexicon: { lead: 'Enquiry', lead_plural: 'Enquiries' },
  onboarding: {
    enabledNavigation: universalNavigation(),
    aiCrmContext:
      'Pharmacy product enquiries, availability, prescription follow-up and repeat purchase assistance. Never provide clinical diagnosis.',
    qualificationFields: ['medicine_or_product', 'availability_need', 'urgency', 'preferred_location'],
    pipeline: pipeline('Pharmacy enquiry pipeline', ['Enquiry', 'Availability confirmed', 'Order fulfilled']),
  },
};

// ---------------------------------------------------------------------------
// TEXTILE
// ---------------------------------------------------------------------------
const TEXTILE: IndustryPack = {
  code: 'textile',
  name: 'Textile & apparel',
  version: 2,
  description:
    'Fabric and apparel retail: fabric type, GSM, colour, width, pattern and cut length.',
  taxonomies: [
    LEAD_SOURCE,
    NEUTRAL_PRODUCT_CATEGORY,
    {
      kind: 'fabric',
      label: 'Fabric',
      terms: [
        { code: 'cotton', label: 'Cotton', sortOrder: 1 },
        { code: 'silk', label: 'Silk', sortOrder: 2 },
        { code: 'linen', label: 'Linen', sortOrder: 3 },
        { code: 'wool', label: 'Wool', sortOrder: 4 },
        { code: 'polyester', label: 'Polyester', sortOrder: 5 },
        { code: 'viscose', label: 'Viscose', sortOrder: 6 },
        { code: 'blend', label: 'Blend', sortOrder: 7 },
        { code: 'other', label: 'Other', sortOrder: 8 },
      ],
    },
    {
      kind: 'pattern',
      label: 'Pattern',
      terms: [
        { code: 'solid', label: 'Solid', sortOrder: 1 },
        { code: 'printed', label: 'Printed', sortOrder: 2 },
        { code: 'striped', label: 'Striped', sortOrder: 3 },
        { code: 'checked', label: 'Checked', sortOrder: 4 },
        { code: 'embroidered', label: 'Embroidered', sortOrder: 5 },
        { code: 'other', label: 'Other', sortOrder: 6 },
      ],
    },
    { kind: 'colour', label: 'Colour', terms: [] },
    checkinPurpose([
      { code: 'browsing', label: 'Browsing', systemValue: 'browsing', sortOrder: 1 },
      { code: 'bridal', label: 'Wedding / occasion', systemValue: 'bridal', sortOrder: 2 },
      { code: 'quote_followup', label: 'Order follow-up', systemValue: 'quote_followup', sortOrder: 3 },
      { code: 'other', label: 'Other', systemValue: 'other', sortOrder: 4 },
    ]),
  ],
  attributes: [
    {
      entity: 'product',
      key: 'fabric',
      label: 'Fabric',
      dataType: 'enum',
      taxonomyKind: 'fabric',
      searchable: true,
      sortOrder: 1,
    },
    { entity: 'product', key: 'gsm', label: 'GSM', dataType: 'number', unit: 'g/m2', sortOrder: 2 },
    {
      entity: 'product',
      key: 'colour',
      label: 'Colour',
      dataType: 'enum',
      taxonomyKind: 'colour',
      searchable: true,
      sortOrder: 3,
    },
    { entity: 'product', key: 'width', label: 'Width', dataType: 'decimal', unit: 'cm', sortOrder: 4 },
    {
      entity: 'product',
      key: 'pattern',
      label: 'Pattern',
      dataType: 'enum',
      taxonomyKind: 'pattern',
      searchable: true,
      sortOrder: 5,
    },
    { entity: 'product', key: 'length', label: 'Length', dataType: 'decimal', unit: 'm', sortOrder: 6 },
  ],
  fieldPolicies: HIDE_JEWELLERY_PRODUCT_FIELDS,
  lexicon: {
    customer: 'Buyer',
    customer_plural: 'Buyers',
    lead: 'Enquiry',
    lead_plural: 'Enquiries',
    product: 'Article',
    product_plural: 'Articles',
    store: 'Showroom',
    store_plural: 'Showrooms',
  },
  onboarding: {
    enabledNavigation: universalNavigation(),
    aiCrmContext:
      'Textile and apparel enquiries, fabric or product requirements, samples, quotations and orders.',
    qualificationFields: ['fabric_or_product', 'quantity', 'colour', 'delivery_timeline'],
    pipeline: pipeline('Textile sales pipeline', ['Enquiry', 'Sample / quotation', 'Order confirmed']),
  },
};

// ---------------------------------------------------------------------------
// CRM-FIRST INDUSTRIES
//
// These packs intentionally model the commercial relationship, not regulated
// operational records. For example, Healthcare stores service interest and an
// appointment preference here; it does not pretend this CRM is an EMR/HIS.
// ---------------------------------------------------------------------------
const HEALTHCARE = servicePack({
  code: 'healthcare',
  name: 'Healthcare & clinics',
  description:
    'Hospitals, clinics and diagnostic centres: enquiries, departments, appointment intent and patient follow-up without storing clinical records.',
  aiCrmContext:
    'Healthcare enquiry and appointment coordination. Never diagnose, prescribe, or treat CRM data as a medical record.',
  qualificationFields: ['service_required', 'preferred_department', 'appointment_date', 'urgency'],
  pipelineName: 'Patient enquiry pipeline',
  pipelineLabels: ['Patient enquiry', 'Appointment proposed', 'Appointment confirmed'],
  visitLabels: ['Appointment / consultation', 'Report or service follow-up'],
  lexicon: { customer: 'Patient', customer_plural: 'Patients', lead: 'Enquiry', lead_plural: 'Enquiries', product: 'Service', product_plural: 'Services', catalogue: 'Services', store: 'Branch', store_plural: 'Branches' },
  attributes: [
    { entity: 'lead', key: 'service_required', label: 'Service required', dataType: 'text', searchable: true, sortOrder: 1 },
    { entity: 'lead', key: 'preferred_department', label: 'Preferred department', dataType: 'text', searchable: true, sortOrder: 2 },
    { entity: 'lead', key: 'appointment_date', label: 'Preferred appointment date', dataType: 'date', sortOrder: 3 },
    { entity: 'lead', key: 'urgency', label: 'Enquiry urgency', dataType: 'enum', options: ['routine', 'soon', 'urgent'], sortOrder: 4 },
    { entity: 'party', key: 'patient_reference', label: 'Patient reference', dataType: 'text', searchable: true, sortOrder: 1 },
  ],
});

const MANUFACTURING = servicePack({
  code: 'manufacturing',
  name: 'Manufacturing',
  description:
    'Manufacturers and industrial businesses: parts, specifications, B2B requirements, quotations, purchase orders and fulfilment.',
  aiCrmContext:
    'B2B manufacturing enquiries, technical requirements, quantities, quotation follow-ups and purchase-order conversion.',
  qualificationFields: ['requirement', 'quantity', 'specification', 'delivery_timeline'],
  pipelineName: 'Manufacturing sales pipeline',
  pipelineLabels: ['Requirement received', 'Technical quote', 'Purchase order received'],
  lexicon: { customer: 'Account', customer_plural: 'Accounts', lead: 'Enquiry', lead_plural: 'Enquiries', product: 'Item', product_plural: 'Items', catalogue: 'Item master', store: 'Plant', store_plural: 'Plants' },
  attributes: [
    { entity: 'product', key: 'part_number', label: 'Part number', dataType: 'text', searchable: true, sortOrder: 1 },
    { entity: 'product', key: 'manufacturer', label: 'Manufacturer', dataType: 'text', searchable: true, sortOrder: 2 },
    { entity: 'product', key: 'unit_of_measure', label: 'Unit of measure', dataType: 'text', sortOrder: 3 },
    { entity: 'product', key: 'specification', label: 'Specification', dataType: 'text', searchable: true, sortOrder: 4 },
    { entity: 'lead', key: 'requirement', label: 'Requirement', dataType: 'text', searchable: true, sortOrder: 1 },
    { entity: 'lead', key: 'quantity', label: 'Required quantity', dataType: 'decimal', sortOrder: 2 },
    { entity: 'lead', key: 'delivery_timeline', label: 'Delivery timeline', dataType: 'date', sortOrder: 3 },
  ],
});

const PROFESSIONAL_SERVICES = servicePack({
  code: 'professional_services',
  name: 'Professional services',
  description:
    'Consulting, agencies, legal, accounting and other service firms: discovery, scope, proposals and engagements.',
  aiCrmContext:
    'Professional-service enquiries, discovery questions, project scope, proposal follow-up and engagement conversion.',
  qualificationFields: ['service_required', 'project_scope', 'budget', 'target_start_date'],
  pipelineName: 'Services pipeline',
  pipelineLabels: ['Discovery', 'Proposal sent', 'Engagement won'],
  lexicon: { customer: 'Client', customer_plural: 'Clients', lead: 'Enquiry', lead_plural: 'Enquiries', product: 'Service', product_plural: 'Services', catalogue: 'Services', store: 'Office', store_plural: 'Offices' },
  attributes: [
    { entity: 'lead', key: 'service_required', label: 'Service required', dataType: 'text', searchable: true, sortOrder: 1 },
    { entity: 'lead', key: 'project_scope', label: 'Project scope', dataType: 'text', sortOrder: 2 },
    { entity: 'lead', key: 'budget', label: 'Budget', dataType: 'decimal', sortOrder: 3 },
    { entity: 'lead', key: 'target_start_date', label: 'Target start date', dataType: 'date', sortOrder: 4 },
    { entity: 'party', key: 'company_size', label: 'Company size', dataType: 'text', sortOrder: 1 },
  ],
});

const REAL_ESTATE = servicePack({
  code: 'real_estate',
  name: 'Real estate & construction',
  description:
    'Developers, brokers and construction firms: buyer requirements, site visits, budgets, proposals and bookings.',
  aiCrmContext:
    'Property and construction enquiries, buyer requirements, site-visit coordination, budget and booking follow-up.',
  qualificationFields: ['property_type', 'preferred_location', 'budget', 'buy_or_rent'],
  pipelineName: 'Property pipeline',
  pipelineLabels: ['Property enquiry', 'Site visit / proposal', 'Booking confirmed'],
  visitLabels: ['Site visit / consultation', 'Proposal follow-up'],
  lexicon: { customer: 'Client', customer_plural: 'Clients', lead: 'Enquiry', lead_plural: 'Enquiries', product: 'Property', product_plural: 'Properties', catalogue: 'Listings', store: 'Office', store_plural: 'Offices' },
  attributes: [
    { entity: 'lead', key: 'property_type', label: 'Property type', dataType: 'enum', options: ['residential', 'commercial', 'land', 'industrial', 'other'], searchable: true, sortOrder: 1 },
    { entity: 'lead', key: 'preferred_location', label: 'Preferred location', dataType: 'text', searchable: true, sortOrder: 2 },
    { entity: 'lead', key: 'budget', label: 'Budget', dataType: 'decimal', sortOrder: 3 },
    { entity: 'lead', key: 'buy_or_rent', label: 'Requirement type', dataType: 'enum', options: ['buy', 'rent', 'lease', 'construction'], sortOrder: 4 },
    { entity: 'lead', key: 'visit_date', label: 'Preferred visit date', dataType: 'date', sortOrder: 5 },
  ],
});

const EDUCATION = servicePack({
  code: 'education',
  name: 'Education & training',
  description:
    'Schools, colleges, coaching and training providers: programme enquiries, counselling, applications and enrolment.',
  aiCrmContext:
    'Education enquiries, programme discovery, counselling scheduling, application follow-up and enrolment support.',
  qualificationFields: ['programme_interest', 'intake', 'study_mode', 'counselling_date'],
  pipelineName: 'Admissions pipeline',
  pipelineLabels: ['Student enquiry', 'Counselling / application', 'Enrolled'],
  visitLabels: ['Counselling / campus visit', 'Application follow-up'],
  lexicon: { customer: 'Student', customer_plural: 'Students', lead: 'Enquiry', lead_plural: 'Enquiries', product: 'Programme', product_plural: 'Programmes', catalogue: 'Programmes', store: 'Centre', store_plural: 'Centres' },
  attributes: [
    { entity: 'lead', key: 'programme_interest', label: 'Programme of interest', dataType: 'text', searchable: true, sortOrder: 1 },
    { entity: 'lead', key: 'intake', label: 'Preferred intake', dataType: 'text', searchable: true, sortOrder: 2 },
    { entity: 'lead', key: 'study_mode', label: 'Study mode', dataType: 'enum', options: ['on_campus', 'online', 'hybrid'], sortOrder: 3 },
    { entity: 'lead', key: 'counselling_date', label: 'Preferred counselling date', dataType: 'date', sortOrder: 4 },
  ],
});

const HOSPITALITY = servicePack({
  code: 'hospitality',
  name: 'Hospitality & travel',
  description:
    'Hotels, restaurants, events and travel businesses: reservation or event enquiries, guest preferences and bookings.',
  aiCrmContext:
    'Hospitality and travel enquiries, reservation details, guest preferences, availability and booking follow-up.',
  qualificationFields: ['booking_type', 'guest_count', 'service_date', 'budget'],
  pipelineName: 'Booking pipeline',
  pipelineLabels: ['Booking enquiry', 'Availability / offer', 'Booking confirmed'],
  visitLabels: ['Reservation / event enquiry', 'Booking follow-up'],
  lexicon: { customer: 'Guest', customer_plural: 'Guests', lead: 'Enquiry', lead_plural: 'Enquiries', product: 'Service', product_plural: 'Services', catalogue: 'Services', store: 'Property', store_plural: 'Properties' },
  attributes: [
    { entity: 'lead', key: 'booking_type', label: 'Booking type', dataType: 'enum', options: ['stay', 'dining', 'event', 'travel', 'other'], searchable: true, sortOrder: 1 },
    { entity: 'lead', key: 'guest_count', label: 'Guest count', dataType: 'number', sortOrder: 2 },
    { entity: 'lead', key: 'service_date', label: 'Preferred date', dataType: 'date', sortOrder: 3 },
    { entity: 'lead', key: 'preferences', label: 'Guest preferences', dataType: 'text', sortOrder: 4 },
  ],
});

const AUTOMOTIVE = servicePack({
  code: 'automotive',
  name: 'Automotive',
  description:
    'Dealers, workshops and parts businesses: vehicle enquiries, test drives, service requests, parts and job follow-up.',
  aiCrmContext:
    'Vehicle sales, test-drive and workshop enquiries, parts requirements, service scheduling and quotation follow-up.',
  qualificationFields: ['vehicle_interest', 'requirement_type', 'budget', 'appointment_date'],
  pipelineName: 'Automotive pipeline',
  pipelineLabels: ['Vehicle / service enquiry', 'Test drive / estimate', 'Sale / job confirmed'],
  visitLabels: ['Test drive / service visit', 'Estimate follow-up'],
  lexicon: { lead: 'Enquiry', lead_plural: 'Enquiries', store: 'Branch', store_plural: 'Branches' },
  attributes: [
    { entity: 'product', key: 'brand', label: 'Brand', dataType: 'text', searchable: true, sortOrder: 1 },
    { entity: 'product', key: 'model', label: 'Model', dataType: 'text', searchable: true, sortOrder: 2 },
    { entity: 'product', key: 'part_number', label: 'Part number', dataType: 'text', searchable: true, sortOrder: 3 },
    { entity: 'lead', key: 'vehicle_interest', label: 'Vehicle / model interest', dataType: 'text', searchable: true, sortOrder: 1 },
    { entity: 'lead', key: 'requirement_type', label: 'Requirement type', dataType: 'enum', options: ['purchase', 'service', 'repair', 'parts'], sortOrder: 2 },
    { entity: 'lead', key: 'appointment_date', label: 'Preferred appointment date', dataType: 'date', sortOrder: 3 },
  ],
});

const WHOLESALE = servicePack({
  code: 'wholesale_distribution',
  name: 'Wholesale & distribution',
  description:
    'Distributors, dealers and wholesalers: trade accounts, volume enquiries, quotations, orders and fulfilment.',
  aiCrmContext:
    'B2B distribution enquiries, trade-account needs, quantities, pricing, repeat orders and fulfilment follow-up.',
  qualificationFields: ['product_interest', 'order_volume', 'sales_channel', 'delivery_timeline'],
  pipelineName: 'Distribution pipeline',
  pipelineLabels: ['Trade enquiry', 'Price / availability', 'Order confirmed'],
  lexicon: { customer: 'Buyer', customer_plural: 'Buyers', lead: 'Enquiry', lead_plural: 'Enquiries', product: 'Item', product_plural: 'Items', store: 'Depot', store_plural: 'Depots' },
  attributes: [
    { entity: 'product', key: 'brand', label: 'Brand', dataType: 'text', searchable: true, sortOrder: 1 },
    { entity: 'product', key: 'unit_of_measure', label: 'Unit of measure', dataType: 'text', sortOrder: 2 },
    { entity: 'lead', key: 'product_interest', label: 'Product interest', dataType: 'text', searchable: true, sortOrder: 1 },
    { entity: 'lead', key: 'order_volume', label: 'Expected order volume', dataType: 'decimal', sortOrder: 2 },
    { entity: 'lead', key: 'sales_channel', label: 'Sales channel', dataType: 'enum', options: ['retail', 'online', 'dealer', 'institutional', 'other'], sortOrder: 3 },
  ],
});

const FINANCIAL_SERVICES = servicePack({
  code: 'financial_services',
  name: 'Financial services',
  description:
    'Insurance, lending and financial advisory teams: product interest, eligibility discovery, applications and conversion. No account secrets are seeded.',
  aiCrmContext:
    'Financial-product enquiries and application follow-up. Never request passwords, PINs, OTPs or full payment-card details.',
  qualificationFields: ['product_interest', 'customer_segment', 'preferred_contact_time', 'application_timeline'],
  pipelineName: 'Financial services pipeline',
  pipelineLabels: ['Product enquiry', 'Application / review', 'Customer onboarded'],
  lexicon: { customer: 'Client', customer_plural: 'Clients', lead: 'Enquiry', lead_plural: 'Enquiries', store: 'Branch', store_plural: 'Branches' },
  attributes: [
    { entity: 'lead', key: 'product_interest', label: 'Product interest', dataType: 'text', searchable: true, sortOrder: 1 },
    { entity: 'lead', key: 'customer_segment', label: 'Customer segment', dataType: 'enum', options: ['individual', 'business', 'institutional'], sortOrder: 2 },
    { entity: 'lead', key: 'preferred_contact_time', label: 'Preferred contact time', dataType: 'text', sortOrder: 3 },
    { entity: 'lead', key: 'application_timeline', label: 'Application timeline', dataType: 'text', sortOrder: 4 },
  ],
});

const TECHNOLOGY = servicePack({
  code: 'technology',
  name: 'Technology & SaaS',
  description:
    'Software, IT services and SaaS businesses: solution fit, discovery, demos, proposals and subscriptions.',
  aiCrmContext:
    'Technology and SaaS enquiries, solution fit, discovery, demos, security questions, proposals and onboarding.',
  qualificationFields: ['solution_area', 'company_size', 'use_case', 'implementation_timeline'],
  pipelineName: 'Technology sales pipeline',
  pipelineLabels: ['Qualified lead', 'Demo / proposal', 'Customer won'],
  lexicon: { customer: 'Account', customer_plural: 'Accounts', store: 'Office', store_plural: 'Offices' },
  attributes: [
    { entity: 'lead', key: 'solution_area', label: 'Solution area', dataType: 'text', searchable: true, sortOrder: 1 },
    { entity: 'lead', key: 'use_case', label: 'Use case', dataType: 'text', searchable: true, sortOrder: 2 },
    { entity: 'lead', key: 'company_size', label: 'Company size', dataType: 'text', sortOrder: 3 },
    { entity: 'lead', key: 'implementation_timeline', label: 'Implementation timeline', dataType: 'text', sortOrder: 4 },
  ],
});

const LOGISTICS = servicePack({
  code: 'logistics',
  name: 'Logistics & transportation',
  description:
    'Freight, courier and transport providers: routes, shipment requirements, quotations and recurring accounts.',
  aiCrmContext:
    'Logistics enquiries, origin and destination, shipment type, expected volume, quotations and account follow-up.',
  qualificationFields: ['service_type', 'origin', 'destination', 'shipment_volume'],
  pipelineName: 'Logistics sales pipeline',
  pipelineLabels: ['Shipment enquiry', 'Rate offered', 'Booking confirmed'],
  lexicon: { lead: 'Enquiry', lead_plural: 'Enquiries', product: 'Service', product_plural: 'Services', catalogue: 'Services', store: 'Branch', store_plural: 'Branches' },
  attributes: [
    { entity: 'lead', key: 'service_type', label: 'Service type', dataType: 'enum', options: ['courier', 'road_freight', 'air_freight', 'sea_freight', 'warehousing', 'other'], searchable: true, sortOrder: 1 },
    { entity: 'lead', key: 'origin', label: 'Origin', dataType: 'text', searchable: true, sortOrder: 2 },
    { entity: 'lead', key: 'destination', label: 'Destination', dataType: 'text', searchable: true, sortOrder: 3 },
    { entity: 'lead', key: 'shipment_volume', label: 'Expected shipment volume', dataType: 'text', sortOrder: 4 },
  ],
});

const OTHER_SERVICES = servicePack({
  code: 'other_services',
  name: 'Other / mixed business',
  description:
    'A neutral CRM-first setup for organisations that do not fit one category. Fields and vocabulary remain editable after signup.',
  aiCrmContext:
    'General customer enquiries, requirements, follow-ups and conversion. Use only the organisation-approved knowledge and policies.',
  qualificationFields: ['requirement', 'budget', 'timeline', 'preferred_location'],
  pipelineName: 'Customer pipeline',
  pipelineLabels: ['Enquiry', 'Proposal / follow-up', 'Converted'],
  attributes: [
    { entity: 'lead', key: 'requirement', label: 'Requirement', dataType: 'text', searchable: true, sortOrder: 1 },
    { entity: 'lead', key: 'budget', label: 'Budget', dataType: 'decimal', sortOrder: 2 },
    { entity: 'lead', key: 'timeline', label: 'Timeline', dataType: 'text', sortOrder: 3 },
  ],
});

export const INDUSTRY_PACKS: Record<string, IndustryPack> = {
  [JEWELLERY.code]: JEWELLERY,
  [RETAIL.code]: RETAIL,
  [PHARMACY.code]: PHARMACY,
  [TEXTILE.code]: TEXTILE,
  [HEALTHCARE.code]: HEALTHCARE,
  [MANUFACTURING.code]: MANUFACTURING,
  [PROFESSIONAL_SERVICES.code]: PROFESSIONAL_SERVICES,
  [REAL_ESTATE.code]: REAL_ESTATE,
  [EDUCATION.code]: EDUCATION,
  [HOSPITALITY.code]: HOSPITALITY,
  [AUTOMOTIVE.code]: AUTOMOTIVE,
  [WHOLESALE.code]: WHOLESALE,
  [FINANCIAL_SERVICES.code]: FINANCIAL_SERVICES,
  [TECHNOLOGY.code]: TECHNOLOGY,
  [LOGISTICS.code]: LOGISTICS,
  [OTHER_SERVICES.code]: OTHER_SERVICES,
};

/** The pack offered when a tenant's industry has no specialised pack. */
export const DEFAULT_PACK_CODE = 'retail';

export function getPack(code: string | null | undefined): IndustryPack | undefined {
  return code ? INDUSTRY_PACKS[code] : undefined;
}

/** Summary list for the onboarding "choose your industry" step. */
export function listPacks() {
  return Object.values(INDUSTRY_PACKS).map((p) => ({
    code: p.code,
    name: p.name,
    version: p.version,
    description: p.description,
  }));
}
