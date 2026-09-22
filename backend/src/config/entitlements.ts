import { getPack } from './industry-packs/packs';

/**
 * Which API family belongs to which module, so the server can refuse a module
 * a tenant's industry does not include.
 *
 * ## Why this exists
 *
 * `enabledNavigation` decided what appeared in the sidebar and nothing else. A
 * clinic's manager who typed /finance still got the page, and FinanceController
 * still answered — its only gate was `@Roles('store_manager','head_office')`,
 * which that manager satisfies. Hiding a door is not locking it, and every
 * module a tenant did not buy was one URL away.
 *
 * ## Capability == navigation slug
 *
 * A capability is not a new vocabulary. It is the route slug the industry pack
 * already lists in `enabledNavigation`, so there is exactly one place that
 * decides whether a tenant has Finance — the pack — and both the menu and the
 * API read it. Introducing a separate capability taxonomy would have created a
 * second list to keep in sync, and the first thing that drifts is the one
 * nobody can see.
 *
 * ## Every controller is classified, not just the gated ones
 *
 * This started as a list of the prefixes to BLOCK, which meant a vertical
 * controller added tomorrow would be universal by omission and nothing would
 * say so. The registry below now names every `@Controller()` prefix in the
 * application and gives each an explicit verdict — a capability, or `null` for
 * "genuinely universal, and here is why".
 *
 * `industry-onboarding.e2e-spec.ts` reads every `@Controller('…')` out of the
 * source tree and fails if one does not resolve here. So adding a controller
 * without classifying it is a red test, not a silent entitlement hole. That
 * enumeration is the mechanism; the ordering below is only for reading.
 *
 * ## What is universal, and why that is a real answer
 *
 * The independently sellable CaratOS suite: authentication, health, tenant
 * configuration, the AI CRM and conversations, the customer directory, the
 * catalogue, attendance and check-ins, stores/team, data import and connectors,
 * integrations, notifications, search, jobs and audit. Every industry pack in
 * this repository enables all of it, so gating any of it could only ever produce
 * a false denial.
 */

export interface RouteFamily {
  /** Controller prefix with a leading slash, as `@Controller()` declares it. */
  prefix: string;
  /** The navigation slug a tenant must have, or null when this is universal. */
  capability: string | null;
  /** Why it is classified this way — read by whoever adds the next controller. */
  why: string;
}

/**
 * Every route family in the application, longest-prefix wins.
 *
 * Longest-prefix matching is load-bearing in three places:
 *   - `/stock-transfers` must not be decided by `/stock`;
 *   - `/integrations/gold-rate` is a jewellery screen while the rest of
 *     `/integrations` is universal;
 *   - `/crm` covers its seven sub-controllers with one entry.
 */
export const ROUTE_FAMILIES: readonly RouteFamily[] = Object.freeze([
  // ── The universal suite ──────────────────────────────────────────────────
  { prefix: '/auth', capability: null, why: 'Signing in cannot depend on what you bought.' },
  { prefix: '/health', capability: null, why: 'Liveness probe; usually unauthenticated.' },
  { prefix: '/config', capability: null, why: 'Tenant configuration is how a tenant learns what it has.' },
  { prefix: '/onboarding', capability: null, why: 'Setup runs before an industry is even chosen.' },
  { prefix: '/users', capability: null, why: 'Team administration is universal.' },
  { prefix: '/stores', capability: null, why: 'Locations are universal; every pack enables settings/stores.' },
  { prefix: '/regions', capability: null, why: 'Store grouping, same reasoning as /stores.' },
  { prefix: '/audit', capability: null, why: 'Every pack enables settings/audit.' },
  { prefix: '/notifications', capability: null, why: 'Product-wide, not module-specific.' },
  { prefix: '/search', capability: null, why: 'Searches whatever the tenant already has.' },
  { prefix: '/assistant', capability: null, why: 'The AI assistant is the core product.' },
  { prefix: '/crm', capability: null, why: 'AI CRM, conversations, customers, pipelines: the core product.' },
  {
    prefix: '/public',
    capability: null,
    why:
      'Anonymous, visitor-facing routes (the embedded website enquiry form). ' +
      'Universal because a capability gate here would be meaningless: there is ' +
      'no signed-in principal to hold a capability, and the tenant is resolved ' +
      'from the unguessable key in the URL. What actually protects these routes ' +
      'is that key, the per-IP throttle and the tenant-status check.',
  },
  {
    prefix: '/public/loyalty',
    capability: null,
    why:
      'The tenant’s own website calling the loyalty API with its own key. ' +
      'Inside /public for the same reason as the enquiry form: there is no ' +
      'signed-in principal to hold a capability. The key resolves to one tenant, ' +
      'and the /loyalty capability still gates every screen a person uses.',
  },
  { prefix: '/leads', capability: null, why: 'A lead is the CRM record itself.' },
  { prefix: '/parties', capability: null, why: 'The customer directory.' },
  { prefix: '/knowledge', capability: null, why: 'Tenant knowledge base feeding the assistant.' },
  { prefix: '/omnichannel', capability: null, why: 'Consent, templates and outbound delivery are part of the universal CRM.' },
  { prefix: '/products', capability: null, why: 'Cataloguing is sold to every industry.' },
  {
    prefix: '/catalogue-exports',
    capability: null,
    why:
      'Head office taking the catalogue’s photographs away as one ZIP. Universal ' +
      'for the same reason /products is; its own prefix so /products/:id cannot ' +
      'swallow the routes.',
  },
  {
    prefix: '/catalogue-integration',
    capability: null,
    why:
      'Head office connecting the catalogue sources (website feed, Gati) and ' +
      'reviewing their sync receipts and conflicts. Universal for the same ' +
      'reason /products is.',
  },
  { prefix: '/checkins', capability: null, why: 'Customer visits are universal; every pack seeds visit purposes.' },
  { prefix: '/hrms', capability: null, why: 'Attendance is sold to every industry.' },
  { prefix: '/imports', capability: null, why: 'Bringing your own data in is universal.' },
  {
    prefix: '/import-mappings',
    capability: null,
    why:
      'Saved column mappings for the import engine. Universal for the same ' +
      'reason /imports is — every tenant arrives with a spreadsheet somebody ' +
      'else designed. A separate prefix from /imports because ImportController ' +
      'owns `:entity/preview`, and a two-segment route under the same prefix ' +
      'would be decided by controller registration order.',
  },
  {
    prefix: '/import-images',
    capability: null,
    why:
      'A ZIP of product photographs matched to the catalogue by filename. ' +
      'Universal: a clinic importing treatment photos and a jeweller importing ' +
      'design shots are the same mechanism over the same catalogue table.',
  },
  { prefix: '/integration', capability: null, why: 'Connect agents and connectors: universal ingestion.' },
  { prefix: '/integrations', capability: null, why: 'Channel integrations; the one vertical screen inside it is listed below.' },
  { prefix: '/integrations-registry', capability: null, why: 'Which providers exist. Distinct path from /integrations.' },
  {
    prefix: '/adapters',
    capability: null,
    why:
      'Read-only: which channels can actually reach a customer today, and why not. ' +
      'Universal, and deliberately open to every role — a salesperson who cannot see ' +
      'that a channel is disconnected keeps promising customers a message on it.',
  },
  {
    prefix: '/messaging-routes',
    capability: null,
    why:
      'Which of a tenant\u2019s numbers each branch sends from. Universal: any industry ' +
      'with more than one location and more than one number has to answer it, and the ' +
      'channel it configures serves the universal CRM.',
  },
  { prefix: '/whatsapp', capability: null, why: 'The WhatsApp channel serves the universal CRM.' },
  { prefix: '/sync', capability: null, why: 'Source-of-truth ingestion, governed by connector auth not industry.' },
  { prefix: '/jobs', capability: null, why: 'Background work plumbing.' },
  { prefix: '/scheduler', capability: null, why: 'Scheduled-job plumbing.' },

  // ── Vertical operations ──────────────────────────────────────────────────
  { prefix: '/finance', capability: 'finance', why: 'Jewellery finance and fund planning.' },
  { prefix: '/loyalty', capability: 'loyalty', why: 'Gold savings schemes and loyalty plans.' },
  { prefix: '/returns', capability: 'returns', why: 'Retail returns and exchange.' },
  { prefix: '/discounts', capability: 'discounts', why: 'Discount approval workflow.' },
  { prefix: '/quotes', capability: 'quotation', why: 'Metal-rate quotation builder.' },
  { prefix: '/materials', capability: 'quotation', why: 'Item master (metals, stones, sizes, style BOMs) the quotation builder prices from.' },
  { prefix: '/timelines', capability: 'quotation', why: 'Custom-order and production-stage tracking; reached from the quotation screen.' },
  { prefix: '/stock-transfers', capability: 'stock-transfers', why: 'Inter-branch stock movement.' },
  { prefix: '/stock', capability: 'inventory', why: 'Inventory and merchandising.' },
  { prefix: '/payments', capability: 'payments', why: 'Payment collection tracking.' },
  { prefix: '/sales', capability: 'payments', why: 'Sale records; the same module as collection.' },
  { prefix: '/marketing', capability: 'marketing', why: 'Campaign management.' },
  {
    prefix: '/attribution',
    capability: 'marketing',
    why: 'Measured ad spend and ROAS report on the campaigns /marketing runs, so they answer to the same gate. Classifying this as universal would hand a tenant without the marketing module a spend screen it can never populate.',
  },
  { prefix: '/tickets', capability: 'ticketing', why: 'Back-office issue management.' },
  { prefix: '/requests', capability: 'requests', why: 'Special customer requests.' },
  { prefix: '/reporting', capability: 'reporting', why: 'DSR and operational reporting.' },
  { prefix: '/dashboard', capability: 'dashboards', why: 'Departmental operational dashboards.' },
  {
    prefix: '/management',
    capability: 'management',
    why:
      'The cross-branch management view: how the business did over a window, ' +
      'with filters. A different question from /dashboard, which answers what is ' +
      'happening in one branch right now — and a separate capability, so a ' +
      'tenant can have the shop-floor screen without the management one.',
  },
  { prefix: '/targets', capability: 'settings/targets', why: 'Sales-target administration.' },
  { prefix: '/new-store', capability: 'new-store', why: 'New-branch opening projects.' },
  {
    prefix: '/feedback',
    capability: null,
    why:
      'Asking a customer how it went, and routing an unhappy answer to a person ' +
      'instead of to a public review page. Universal: every industry that serves ' +
      'someone can ask. Visibility is the pack navigation slug, as with /crm.',
  },
  {
    prefix: '/staff-digest',
    capability: null,
    why:
      'The morning list of who a staff member owes a follow-up. Universal for ' +
      'the same reason /calling is — chasing a follow-up is what every CRM is ' +
      'for. Visibility follows the pack navigation slug, not a capability gate.',
  },
  {
    prefix: '/lead-tags',
    capability: null,
    why:
      'Tenant-defined labels on a lead. Universal for the same reason /crm is: ' +
      'a clinic tagging a patient enquiry "insurance query" and a jeweller ' +
      'tagging one "potential lead" are the same feature. The vocabulary is the ' +
      'tenant\'s own, so nothing here is vertical.',
  },
  {
    prefix: '/calling',
    capability: null,
    why:
      'The central follow-up / tele-calling queue. Chasing a follow-up is what ' +
      'every CRM is for, so it is classified like /crm and /checkins: universal, ' +
      'with visibility controlled by whether the pack lists the `calling` ' +
      'navigation slug rather than by a capability gate on the API.',
  },
  {
    prefix: '/instore',
    capability: null,
    why:
      'The floor/field application — a clinic reception, a plant visitor desk ' +
      'and a showroom counter are the same workflow. Universal for the same ' +
      'reason as /checkins, which it writes to.',
  },
  {
    prefix: '/campaigns',
    capability: null,
    why:
      'Reaching customers is universal: a clinic, a mill and a dealership all ' +
      'do it. Deliberately NOT under the jewellery-only `marketing` gate, which ' +
      'covers agency planning (briefs, budgets, a bridal/festive campaign type) ' +
      '— and a separate prefix anyway, because /marketing/campaigns is already ' +
      'a live route on that planning module.',
  },
  {
    prefix: '/audiences',
    capability: null,
    why: 'The audience builder exists only to feed campaigns; same classification.',
  },
  {
    prefix: '/integrations/gold-rate',
    capability: 'settings/rates',
    why: 'The metal rate is a jewellery screen inside the otherwise-universal integrations controller.',
  },
]);

/** Every capability this registry can demand. Exposed so a test can pin the set. */
export const GATED_CAPABILITIES: readonly string[] = Object.freeze([
  ...new Set(
    ROUTE_FAMILIES.map((f) => f.capability).filter((c): c is string => c !== null),
  ),
]);

/**
 * The family a path belongs to, or null when no family claims it.
 *
 * A prefix matches only at a segment boundary, so `/salesforce-webhook` is not
 * caught by the `/sales` entry. Query strings and trailing slashes are ignored.
 */
export function familyForPath(rawPath: string): RouteFamily | null {
  const path = normalise(rawPath);
  let best: RouteFamily | null = null;
  for (const family of ROUTE_FAMILIES) {
    if (path !== family.prefix && !path.startsWith(`${family.prefix}/`)) continue;
    if (!best || family.prefix.length > best.prefix.length) best = family;
  }
  return best;
}

/**
 * The capability a request path requires, or null when it needs none.
 *
 * Null covers two different cases on purpose: a family classified universal, and
 * a path no family claims. The second cannot survive review — the enumeration
 * test fails on an unclassified controller — and at request time it is treated
 * as universal, because a route the registry has never heard of is far more
 * likely to be internal plumbing than a vertical module, and guessing "deny"
 * would break a working screen for every tenant at once.
 */
export function capabilityForPath(rawPath: string): string | null {
  return familyForPath(rawPath)?.capability ?? null;
}

/**
 * Does this industry pack include `capability`?
 *
 * A pack that cannot be resolved — never applied, or a code this release does
 * not ship — answers FALSE. Only paths the registry classifies as VERTICAL ever
 * reach this function, so the strictness is bounded: the universal suite is
 * decided before we get here and stays reachable for a tenant with no pack at
 * all, which is exactly what a half-finished onboarding needs.
 *
 * This is the direction the phase-2 note argued against, and the argument does
 * not survive the registry. Failing open was insurance against an unmapped
 * controller silently going dark; now every controller is classified and a test
 * proves it, so the remaining fail-open cases are only the ones we actually mean
 * — a tenant reaching a module their industry never included.
 */
export function packAllows(packCode: string | null | undefined, capability: string): boolean {
  const enabled = getPack(packCode)?.onboarding?.enabledNavigation;
  if (!enabled?.length) return false;
  return enabled.includes(capability);
}

/**
 * What this TENANT can reach: their industry's modules, minus the ones they
 * have switched off.
 *
 * Two questions, deliberately separate. `packAllows` answers "does this
 * industry's product include this module" and is a property of the release.
 * This answers "can this organisation reach it today" and is a property of the
 * tenant. Collapsing them would mean either editing a pack to suit one customer
 * — which changes it for every other tenant in that industry — or putting a
 * customer's name in the authorisation path, where the next customer with the
 * same preference needs another code change to be served.
 *
 * The subtraction is one-directional on purpose: a tenant can turn OFF a module
 * their industry includes, never turn ON one it does not. Enabling something the
 * pack never provisioned would give them a screen with no vocabulary, no
 * attributes and no pipeline behind it.
 */
export function tenantAllows(
  packCode: string | null | undefined,
  disabledCapabilities: readonly string[] | null | undefined,
  capability: string,
): boolean {
  if (disabledCapabilities?.includes(capability)) return false;
  return packAllows(packCode, capability);
}

/**
 * The modules a tenant can actually reach, as one list.
 *
 * Derived on every read rather than stored — see the note on
 * `Organisation.disabledCapabilities` for why a stored copy freezes.
 */
export function enabledCapabilitiesFor(
  packCode: string | null | undefined,
  disabledCapabilities: readonly string[] | null | undefined,
): string[] | null {
  const enabled = getPack(packCode)?.onboarding?.enabledNavigation;
  if (!enabled?.length) return null;
  const off = new Set(disabledCapabilities ?? []);
  return enabled.filter((capability) => !off.has(capability));
}

/**
 * Which modules a tenant may switch off.
 *
 * Everything their pack includes EXCEPT the universal spine. Turning off the
 * customer directory, the team screen or the audit log would leave a tenant
 * unable to run the product or to see who did what — and, for settings/team,
 * unable to give themselves back the access they just removed.
 */
export const UNDISABLEABLE_CAPABILITIES: readonly string[] = Object.freeze([
  'crm',
  'conversations',
  'customers',
  'settings/team',
  'settings/configuration',
  'settings/audit',
]);

/**
 * The metal-rate capability, named once.
 *
 * Used by the entitlement guard (via the registry) AND by the hourly refresh
 * job, so "which tenants have gold rates" has exactly one definition.
 */
export const METAL_RATES_CAPABILITY = 'settings/rates';

/** Does this pack ask for metal rates to be MAINTAINED for it? */
export function packMaintainsMetalRates(packCode: string | null | undefined): boolean {
  return packAllows(packCode, METAL_RATES_CAPABILITY);
}

/**
 * Convenience for the guard: may this tenant reach this path?
 *
 * Returns WHY it was refused, because the two reasons need different sentences:
 * a module the industry never included is a configuration question for an
 * administrator, while one the tenant switched off is a switch somebody here can
 * turn back on.
 */
export function pathAllowedForPack(
  packCode: string | null | undefined,
  path: string,
  disabledCapabilities?: readonly string[] | null,
): { allowed: true } | { allowed: false; capability: string; reason: 'pack' | 'disabled' } {
  const capability = capabilityForPath(path);
  if (!capability) return { allowed: true };
  if (disabledCapabilities?.includes(capability)) {
    return { allowed: false, capability, reason: 'disabled' };
  }
  if (packAllows(packCode, capability)) return { allowed: true };
  return { allowed: false, capability, reason: 'pack' };
}

function normalise(rawPath: string): string {
  const withoutQuery = (rawPath || '/').split('?')[0];
  const trimmed = withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, '') : withoutQuery;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
