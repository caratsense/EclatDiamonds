/**
 * Two brands, two constants, and the distinction between them is the point:
 * PRODUCT_NAME is the platform the software *is*, TENANT_NAME is the shop it
 * is being run *for*. The lockup prints both — platform on top, "by <tenant>"
 * beneath — which is why neither may be folded into the other, and why both
 * stay configuration rather than copy scattered through components.
 *
 * The name of the platform itself: CaratOS → CaratSpace (10 Oct 2026) →
 * briefly Nibhana (24 Oct 2026, when the two brands were treated as one
 * thing) → CaratSpace again (29 Oct 2026, once they were separated).
 */
export const PRODUCT_NAME = "CaratSpace";

/**
 * The flagship client's business name (Éclat Diamonds → Nibhana, 10 Oct
 * 2026). Used only where tenant copy is hardcoded as a fallback or example;
 * real tenant names still come from the API.
 */
export const TENANT_NAME = "Nibhana";
