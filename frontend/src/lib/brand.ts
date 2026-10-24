/**
 * The product's display name is configuration, not copy scattered through
 * components — CaratOS → CaratSpace (10 Oct 2026) → Nibhana (24 Oct 2026).
 *
 * CaratSpace is a separate product in its own repository now; this one is
 * dedicated to Éclat Diamonds, who trade as Nibhana. Product and tenant name
 * are therefore the same string here, and deliberately kept as two constants:
 * the platform name and the shop's name are different ideas even when they
 * currently read alike.
 */
export const PRODUCT_NAME = "Nibhana";

/**
 * The flagship tenant's business name (Éclat Diamonds → Nibhana, same
 * 10 Oct 2026 rename). Used only where tenant copy is hardcoded as a
 * fallback or example; real tenant names still come from the API.
 */
export const TENANT_NAME = "Nibhana";
