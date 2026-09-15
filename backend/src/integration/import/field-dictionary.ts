/**
 * CaratOS import — canonical field dictionaries + column-mapping suggestions.
 *
 * Different systems name the same thing differently ("Customer Mob", "Phone No",
 * "Contact"). This maps a source column to a canonical CaratOS field by matching
 * the normalised header against a per-field alias list. Suggestions are ADVISORY —
 * the user confirms every mapping; nothing is auto-committed on a guess. Unknown
 * columns are surfaced, never silently dropped.
 *
 * Only entities that are safe to import today are defined. Add an entity by adding
 * its field spec — the pipeline is entity-agnostic.
 */

export type ImportEntity = 'customers' | 'stores' | 'products';

export interface CanonicalFieldSpec {
  /** Canonical field key, e.g. 'name' | 'phone'. */
  field: string;
  /** Human label for the mapping UI. */
  label: string;
  /** True if a row cannot be imported without it. */
  required: boolean;
  /** Advisory: not required, but strongly encouraged (drives template hints). */
  recommended?: boolean;
  /** Header aliases (normalised, lowercase, alnum only) that map to this field. */
  aliases: string[];
}

/** Per-entity canonical field specs. */
export const FIELD_DICTIONARY: Record<ImportEntity, CanonicalFieldSpec[]> = {
  customers: [
    { field: 'name', label: 'Customer Name', required: true, aliases: ['name', 'customername', 'customer', 'partyname', 'party', 'clientname', 'buyername', 'fullname'] },
    { field: 'code', label: 'External Customer Code', required: false, aliases: ['code', 'customercode', 'partycode', 'ledgerguid', 'ledgercode', 'externalid'] },
    { field: 'phone', label: 'Phone', required: false, recommended: true, aliases: ['phone', 'phoneno', 'phonenumber', 'mobile', 'mobileno', 'mobilenumber', 'contact', 'contactno', 'customermob', 'mob', 'cell', 'whatsapp'] },
    { field: 'email', label: 'Email', required: false, aliases: ['email', 'emailid', 'emailaddress', 'mail', 'emailaddr'] },
    { field: 'city', label: 'City', required: false, aliases: ['city', 'town', 'place', 'location'] },
    { field: 'gstin', label: 'GSTIN', required: false, aliases: ['gstin', 'gst', 'gstno', 'gstnumber'] },
    { field: 'birthday', label: 'Birthday', required: false, aliases: ['birthday', 'dob', 'dateofbirth', 'birthdate'] },
    { field: 'anniversary', label: 'Anniversary', required: false, aliases: ['anniversary', 'anniversarydate', 'weddinganniversary'] },
  ],
  stores: [
    { field: 'name', label: 'Store Name', required: true, aliases: ['name', 'storename', 'branch', 'branchname', 'shop', 'shopname', 'outlet'] },
    { field: 'city', label: 'City', required: false, recommended: true, aliases: ['city', 'town', 'place', 'location'] },
    { field: 'code', label: 'Store Code', required: false, recommended: true, aliases: ['code', 'storecode', 'branchcode', 'shortcode'] },
    { field: 'gstin', label: 'GSTIN', required: false, aliases: ['gstin', 'gst', 'gstno', 'gstnumber'] },
    { field: 'phone', label: 'Phone', required: false, aliases: ['phone', 'phoneno', 'contact', 'contactno', 'landline'] },
    { field: 'email', label: 'Email', required: false, aliases: ['email', 'emailid', 'mail'] },
    { field: 'addressLine1', label: 'Address', required: false, aliases: ['address', 'addressline1', 'addr', 'line1', 'street'] },
    { field: 'state', label: 'State', required: false, aliases: ['state', 'province', 'region'] },
    { field: 'pincode', label: 'Pincode', required: false, aliases: ['pincode', 'pin', 'zip', 'zipcode', 'postalcode'] },
  ],
  products: [
    { field: 'sku', label: 'SKU', required: true, aliases: ['sku', 'itemcode', 'code', 'productcode', 'designcode', 'articlecode', 'stylecode', 'tagno'] },
    { field: 'name', label: 'Product Name', required: true, aliases: ['name', 'itemname', 'productname', 'designname', 'description', 'item'] },
    // The DESIGN, above the SKU. Many SKUs share one style number, which is why
    // it is a separate field and not another alias for `sku`.
    { field: 'styleNumber', label: 'Style / Design Number', required: false, recommended: true, aliases: ['styleno', 'stylenumber', 'style', 'designno', 'designnumber', 'design', 'modelno', 'modelnumber', 'pattern', 'patternno'] },
    { field: 'category', label: 'Category', required: false, recommended: true, aliases: ['category', 'type', 'producttype', 'group', 'itemgroup'] },
    { field: 'metal', label: 'Material / Metal', required: false, recommended: true, aliases: ['metal', 'metaltype', 'material', 'materialtype', 'composition'] },
    { field: 'karat', label: 'Karat / Purity', required: false, recommended: true, aliases: ['karat', 'carat', 'kt', 'purity', 'fineness', 'touch'] },
    { field: 'weightGrams', label: 'Weight (g)', required: false, recommended: true, aliases: ['weight', 'wt', 'grossweight', 'gwt', 'weightgrams', 'grams', 'gms'] },
    { field: 'price', label: 'Price (₹)', required: false, aliases: ['price', 'mrp', 'rate', 'sellingprice', 'retailprice', 'amount'] },
    { field: 'unitOfMeasure', label: 'Unit of Measure', required: false, aliases: ['unit', 'uom', 'unitofmeasure', 'baseunit', 'stockunit'] },
    // Block 9. Standard / customised (made to order) / non-stock (display,
    // sample). Values are normalised in the importer; an unrecognised one is a
    // warning and leaves the design as it was, never a guess.
    { field: 'stockClass', label: 'Stock classification', required: false, aliases: ['stockclass', 'stockclassification', 'classification', 'stocktype', 'itemclass', 'ordertype', 'madetoorder', 'mto', 'customised', 'customized'] },
  ],
};

/** Normalise a header for matching: lowercase, strip everything but a-z0-9. */
export function normaliseHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface MappingSuggestion {
  /** Source column name (verbatim). */
  sourceColumn: string;
  /** Suggested canonical field, or null if no confident match. */
  canonicalField: string | null;
  /** 0–1 confidence. 1 = exact alias hit, 0 = unmatched. */
  confidence: number;
}

/**
 * Suggest a canonical field for each source header. Exact alias match => 1.0;
 * a header that CONTAINS an alias (or vice-versa) => 0.6; otherwise unmatched.
 * Each canonical field is suggested at most once (best header wins) so two
 * columns can't both claim `phone`.
 */
export function suggestMappings(headers: string[], entity: ImportEntity): MappingSuggestion[] {
  const specs = FIELD_DICTIONARY[entity];
  const suggestions: MappingSuggestion[] = headers.map((h) => ({
    sourceColumn: h,
    canonicalField: null,
    confidence: 0,
  }));

  const claimed = new Set<string>();
  // Two passes: exact matches first (they should win), then fuzzy.
  for (const exactPass of [true, false]) {
    headers.forEach((header, i) => {
      if (suggestions[i].canonicalField) return;
      const norm = normaliseHeader(header);
      if (!norm) return;
      let best: { field: string; conf: number } | null = null;
      for (const spec of specs) {
        if (claimed.has(spec.field)) continue;
        for (const alias of spec.aliases) {
          let conf = 0;
          if (norm === alias) conf = 1;
          else if (!exactPass && (norm.includes(alias) || alias.includes(norm))) conf = 0.6;
          if (conf > (best?.conf ?? 0)) best = { field: spec.field, conf };
        }
      }
      if (best && ((exactPass && best.conf === 1) || (!exactPass && best.conf >= 0.6))) {
        suggestions[i] = { sourceColumn: header, canonicalField: best.field, confidence: best.conf };
        claimed.add(best.field);
      }
    });
  }
  return suggestions;
}
