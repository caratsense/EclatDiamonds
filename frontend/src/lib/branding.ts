/**
 * Reading a tenant's own name out of the settings bag.
 *
 * `Organisation.settings.branding.displayName` is written at signup and
 * published on `GET /config/bootstrap`. It is what the tenant calls themselves,
 * which is not always their registered organisation name — so it wins where it
 * exists, and the organisation name is the fallback.
 *
 * Defensive because `settings` is an untyped JSON column that several unrelated
 * features write to: anything that is not a non-empty string returns null, and
 * the caller falls back rather than rendering "[object Object]" in a sidebar.
 */
export function brandingName(settings: Record<string, unknown> | undefined): string | null {
  const branding = settings?.branding;
  if (!branding || typeof branding !== "object" || Array.isArray(branding)) return null;
  const name = (branding as Record<string, unknown>).displayName;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/**
 * The one organisation that owns the Éclat Diamonds artwork.
 *
 * A slug, not a name or an industry: "jewellery" is a pack many tenants can
 * choose, and a second jeweller signing up must get their own name rather than
 * inheriting this one's logo.
 */
export const ECLAT_SLUG = "eclat";
