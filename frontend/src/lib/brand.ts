/**
 * The product's display name is configuration, not copy scattered through
 * components — CaratOS → CaratSpace (10 Oct 2026).
 *
 * CaratSpace is the software CaratSense builds; Nibhana (formerly Éclat
 * Diamonds) is the client it is built for. The two are kept as separate
 * constants because they are different ideas: a client rename changes
 * TENANT_NAME, never this.
 */
export const PRODUCT_NAME = "CaratSpace";

/**
 * The flagship tenant's business name (Éclat Diamonds, trading as Nibhana).
 * Used only where tenant copy is hardcoded as a
 * fallback or example; real tenant names still come from the API.
 */
export const TENANT_NAME = "Nibhana";
