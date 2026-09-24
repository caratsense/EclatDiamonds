import { Role } from '@prisma/client';

/**
 * Who may open which screen, and how far.
 *
 * Every sidebar screen has a slug (the same slugs as the frontend navigation).
 * A person holds each screen at one of two levels, or not at all:
 *
 *   - `own`   — their own records (a salesperson's leads, attendance, leave);
 *   - `store` — the whole of their store(s), as a store manager sees it.
 *
 * A role has defaults (ROLE_ACCESS). Head office can change them for one
 * person (`User.accessOverrides`): switch a screen off, or on at either level.
 * The server enforces it (ModuleAccessGuard): a screen switched off is refused,
 * and a screen given at `store` level really works — the person is treated as
 * a store manager for that screen's API only, still inside their own stores.
 * Head office always has everything; overrides never apply to it.
 */

export type AccessLevel = 'own' | 'store';
export type AccessOverride = AccessLevel | 'none';
export type AccessMap = Record<string, AccessLevel>;

export const MODULES = [
  // Overview & Analytics
  'dashboards', 'activity', 'reporting', 'store-comparison', 'management', 'reporting/scheduled',
  // CRM
  'conversations', 'crm', 'calling', 'reminders', 'customers', 'feedback', 'tasks',
  'conversations/sla', 'customers/archived',
  // Showroom floor
  'instore', 'checkins',
  // Commerce & Orders
  'catalogue', 'quotation', 'payments', 'discounts', 'returns', 'loyalty', 'loyalty/programme',
  // Inventory & Supply
  'inventory', 'stock-transfers', 'inventory/dead-stock',
  // Marketing & Inbound
  'campaigns', 'lead-forms', 'marketing',
  // HRM
  'settings/team', 'hrms', 'sales-performance', 'settings/targets', 'hrms/payroll',
  // Back-office & Approvals
  'approvals', 'requests', 'ticketing', 'finance',
  // Administration
  'settings/onboarding', 'settings/stores', 'new-store', 'settings/configuration', 'settings/rates',
  'settings/integrations', 'data', 'settings/audit', 'settings/staff-digest', 'settings/lead-tags',
  'data/images', 'settings/messaging-routes', 'settings/channels', 'settings/access',
] as const;

export type ModuleSlug = (typeof MODULES)[number];

const at = (level: AccessLevel, slugs: ModuleSlug[]): AccessMap =>
  Object.fromEntries(slugs.map((s) => [s, level]));

/** The front-line day: punch, DSR, catalogue, leave, customers, quotes. */
const SALESPERSON: ModuleSlug[] = [
  'hrms', 'reporting', 'catalogue', 'conversations', 'crm', 'calling', 'reminders', 'customers',
  'tasks', 'instore', 'checkins', 'quotation', 'discounts', 'returns', 'loyalty', 'requests', 'ticketing',
];

/**
 * A store manager: everything a salesperson has, at store level, plus running
 * the store — commerce, stock, the team (HRM), the store's dashboard, DSRs and
 * approvals. Not marketing, finance, cross-store views or administration.
 */
const STORE_MANAGER: ModuleSlug[] = [
  ...SALESPERSON,
  'dashboards', 'feedback', 'conversations/sla', 'customers/archived',
  'payments', 'loyalty/programme',
  'inventory', 'stock-transfers', 'inventory/dead-stock', 'data/images',
  'settings/team', 'sales-performance', 'settings/targets', 'hrms/payroll',
  'approvals',
];

/** Marketing, one per store: CRM, marketing and inbound, their own attendance and leave. */
const MARKETING: AccessMap = {
  ...at('store', [
    'conversations', 'crm', 'calling', 'reminders', 'customers', 'feedback',
    'conversations/sla', 'customers/archived', 'campaigns', 'lead-forms', 'marketing', 'settings/lead-tags',
  ]),
  ...at('own', ['hrms', 'tasks']),
};

export const ROLE_ACCESS: Record<Role, AccessMap> = {
  salesperson: at('own', SALESPERSON),
  store_manager: at('store', STORE_MANAGER),
  marketing: MARKETING,
  head_office: at('store', [...MODULES]),
  // Retired roles (nobody holds them; not assignable). Kept closed.
  area_manager: at('store', STORE_MANAGER),
  storeperson: at('own', ['hrms', 'catalogue', 'inventory', 'inventory/dead-stock', 'data/images']),
};

/**
 * Screens only head office can use: their APIs are head-office-only (and one of
 * them edits access itself), so they are never given to anybody else.
 */
export const HEAD_OFFICE_ONLY: ModuleSlug[] = [
  'settings/onboarding', 'new-store', 'settings/configuration', 'settings/integrations',
  'settings/messaging-routes', 'settings/access',
];

/** The roles in use. Area manager and storeperson are retired: nobody can be given them. */
export const ACTIVE_ROLES: Role[] = ['salesperson', 'store_manager', 'marketing', 'head_office'];

/** What this person may open: their role's defaults with head office's changes applied. */
export function effectiveAccess(role: Role, overrides: unknown): AccessMap {
  const base = { ...ROLE_ACCESS[role] };
  if (role === 'head_office' || !overrides || typeof overrides !== 'object') return base;
  for (const [slug, v] of Object.entries(overrides as Record<string, unknown>)) {
    if (!(MODULES as readonly string[]).includes(slug)) continue;
    if (v === 'none') delete base[slug];
    else if (v === 'own' || v === 'store') base[slug] = v;
  }
  return base;
}

/**
 * The API a screen owns, by path prefix; longest prefix wins. Only APIs that
 * belong to ONE screen are listed. Shared reference APIs (products, parties,
 * stores, users, config, rates, notifications, search, sales, payments…) are
 * used by many screens and stay governed by the role checks alone — so are
 * lead tags, audit history, visit feedback, response-time clocks and enquiry
 * forms (CRM and the floor app read them), the tag lookup at the counter, the
 * personal morning digest, the welcome tour, and payroll (each person reads their own payslips;
 * it counts as HRMS).
 */
const ROUTE_MODULES: [prefix: string, module: ModuleSlug | null][] = [
  ['dashboard', 'dashboards'],
  // The floor app shows the store's handoffs and agenda too: shared.
  ['dashboard/handoffs', null],
  ['dashboard/agenda', null],
  // A person's own task list lives under the dashboard API.
  ['dashboard/tasks', 'tasks'],
  ['management', 'management'],
  ['reporting/scheduled', 'reporting/scheduled'],
  ['reporting', 'reporting'],
  ['crm/conversations', 'conversations'],
  ['crm/omnichannel', 'conversations'],
  ['omnichannel', 'conversations'],
  ['crm/follow-up-reminders', 'reminders'],
  ['calling', 'calling'],
  ['campaigns', 'campaigns'],
  ['audiences', 'campaigns'],
  ['attribution/meta-ads', 'campaigns'],
  ['marketing', 'marketing'],
  ['leads', 'crm'],
  ['crm/leads', 'crm'],
  ['crm/pipelines', 'crm'],
  ['crm/qualification', 'crm'],
  ['crm/round-robin', 'crm'],
  ['crm/segments', 'crm'],
  ['crm/lead-qr', 'crm'],
  ['crm/import-batches', 'crm'],
  ['crm/exports', 'crm'],
  ['crm/customers', 'customers'],
  ['instore', 'instore'],
  ['checkins', 'checkins'],
  ['catalogue-exports', 'catalogue'],
  ['quotes', 'quotation'],
  // The item master the quote builder prices from.
  ['materials', 'quotation'],
  ['timelines', 'quotation'],
  ['discounts', 'discounts'],
  ['returns', 'returns'],
  ['loyalty/programme', 'loyalty/programme'],
  ['loyalty', 'loyalty'],
  ['stock/dead', 'inventory/dead-stock'],
  // The tag lookup at the counter: anyone who may hold a piece. Shared.
  ['stock/vin', null],
  ['stock-transfers', 'stock-transfers'],
  ['stock', 'inventory'],
  ['hrms', 'hrms'],
  ['targets', 'settings/targets'],
  ['requests', 'requests'],
  ['tickets', 'ticketing'],
  ['finance', 'finance'],
  ['new-store', 'new-store'],
  ['messaging-routes', 'settings/messaging-routes'],
];
/**
 * Shared APIs that one screen nonetheless leads: a person who HOLDS that screen
 * is served at their level for it (marketing works feedback and enquiry forms
 * as a manager), and anyone else passes through to the role checks unchanged —
 * never refused here, because other screens read these too.
 */
const SOFT_ROUTE_MODULES: [prefix: string, module: ModuleSlug][] = [
  ['feedback', 'feedback'],
  ['crm/sla', 'conversations/sla'],
  ['crm/lead-forms', 'lead-forms'],
  ['lead-tags', 'settings/lead-tags'],
  ['integrations-registry', 'conversations'],
];

type Route = { module: ModuleSlug | null; soft: boolean };
const BY_LENGTH: [string, Route][] = [
  ...ROUTE_MODULES.map(([p, m]): [string, Route] => [p, { module: m, soft: false }]),
  ...SOFT_ROUTE_MODULES.map(([p, m]): [string, Route] => [p, { module: m, soft: true }]),
].sort((a, b) => b[0].length - a[0].length);

/** The screen an API path belongs to (and whether only softly), or null when shared. */
export function routeForPath(path: string): Route | null {
  const p = path.split('?')[0].replace(/^\/+|\/+$/g, '');
  for (const [prefix, route] of BY_LENGTH) {
    if (p === prefix || p.startsWith(`${prefix}/`)) return route.module ? route : null;
  }
  return null;
}

/** The screen an API path belongs to, or null when it is shared or not a screen's. */
export function moduleForPath(path: string): ModuleSlug | null {
  const r = routeForPath(path);
  return r && !r.soft ? r.module : null;
}
