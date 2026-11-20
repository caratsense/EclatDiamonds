// Kept out of page.tsx: a Next.js page file may export only what Next.js
// expects, and any other export fails the production build.

/**
 * Organisation slugs, as the server mints them: lowercase, alphanumeric, single
 * hyphens between segments, no leading or trailing hyphen. "eclat" and
 * "sunrise-clinic-3ebcb7d2" are both real examples.
 */
const ORG_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Trim and lowercase, and nothing else.
 *
 * Deliberately non-destructive: a code with a space or a slash in it is left
 * visibly wrong rather than silently rewritten into a different tenant's slug.
 * Turning "Sunrise Clinic" into "sunrise-clinic" would be a guess, and a guess
 * that happened to hit an existing organisation would show a stranger's
 * branches.
 */
export function normaliseOrgSlug(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

/** Could this string name a real organisation? Two characters minimum. */
export function isUsableOrgSlug(raw: string | null | undefined): boolean {
  const slug = normaliseOrgSlug(raw);
  return slug.length >= 2 && ORG_SLUG_PATTERN.test(slug);
}

/**
 * The organisation this deployment is for, or "" — never a hardcoded tenant.
 *
 * The signup form used to open on `NEXT_PUBLIC_DEFAULT_ORG_SLUG ?? "eclat"`, so
 * a clinic's new receptionist, on a generic deployment with nothing configured,
 * was shown a jeweller's branch list and pointed at their organisation. The
 * fallback is gone: absent configuration now means an empty field and no
 * request, which is the honest state — the product does not know which tenant
 * this person belongs to, and asking is the only correct move.
 *
 * A single-tenant deployment can still pin itself by setting the variable, but
 * the value is validated first. A malformed one is ignored rather than sent to
 * the directory endpoint, because a build-time typo should degrade to "ask the
 * user", never to "query something arbitrary".
 *
 * Nothing here reads the hostname. Inferring a tenant from the URL would make
 * the answer depend on which domain someone happened to load, including
 * localhost and any domain later pointed at this app.
 */
export function configuredOrgSlug(
  raw: string | undefined = process.env.NEXT_PUBLIC_DEFAULT_ORG_SLUG,
): string {
  const slug = normaliseOrgSlug(raw);
  return isUsableOrgSlug(slug) ? slug : "";
}
