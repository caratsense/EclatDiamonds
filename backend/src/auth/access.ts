import { Prisma, Role } from '@prisma/client';

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
 *
 * A workspace can start its sales staff on attendance only instead of the
 * salesperson defaults (`startsAttendanceOnly`); head office's changes for one
 * person then apply on top of that.
 */

export type AccessLevel = 'own' | 'store';
export type AccessOverride = AccessLevel | 'none';
export type AccessMap = Record<string, AccessLevel>;

export const MODULES = [
  // Overview & Analytics
  'dashboards', 'activity', 'reporting', 'store-comparison', 'management', 'reporting/scheduled',
  // CRM
  'conversations', 'crm', 'calling', 'reminders', 'customers', 'feedback', 'tasks',
  'conversations/sla', 'customers/archived', 'bot-script', 'bot-script/edit', 'nps',
  // Showroom floor
  'instore', 'checkins',
  // Commerce & Orders
  'catalogue', 'catalogue/integration', 'quotation', 'payments', 'discounts', 'returns', 'loyalty', 'loyalty/programme',
  // Inventory & Supply
  'inventory', 'stock-transfers', 'inventory/dead-stock', 'inventory/by-store',
  // Marketing & Inbound
  'campaigns', 'lead-forms', 'marketing',
  // HRM
  'settings/team', 'hrms', 'sales-performance', 'settings/targets', 'hrms/payroll',
  'hrms/employees',
  // Back-office & Approvals
  'approvals', 'requests', 'ticketing', 'finance',
  // Administration
  'settings/onboarding', 'settings/stores', 'new-store', 'settings/configuration', 'settings/rates',
  'settings/integrations', 'settings/integrations/templates',
  'data', 'settings/audit', 'settings/staff-digest', 'settings/lead-tags', 'settings/product-groups',
  'settings/export-formats', 'settings/quick-replies',
  'data/images', 'settings/messaging-routes', 'settings/channels', 'settings/access',
] as const;

export type ModuleSlug = (typeof MODULES)[number];

const at = (level: AccessLevel, slugs: ModuleSlug[]): AccessMap =>
  Object.fromEntries(slugs.map((s) => [s, level]));

/** The front-line day: punch, DSR, catalogue, leave, customers, quotes. */
const SALESPERSON: ModuleSlug[] = [
  'hrms', 'reporting', 'catalogue', 'conversations', 'crm', 'calling', 'reminders', 'customers',
  'tasks', 'instore', 'checkins', 'quotation', 'discounts', 'returns', 'loyalty', 'requests', 'ticketing',
  // Raising a stock transfer (client, 9 Oct: staff initiate; managers fulfil).
  // The API keeps dispatch/receive at store_manager and approve at head_office.
  'stock-transfers',
];

/**
 * A store manager: everything a salesperson has, at store level, plus running
 * the store — commerce, stock, the team (HRM), the store's dashboard, DSRs and
 * approvals. Not marketing, finance, cross-store views or administration.
 */
const STORE_MANAGER: ModuleSlug[] = [
  ...SALESPERSON,
  /*
   * Reading the bot's wording, beside the inbox it speaks into. Safe at store
   * level deliberately: the screen may be open, but
   * SAVING the script is head-office-only at the API, so a manager sees the
   * words and cannot change them.
   */
  'bot-script',
  'dashboards', 'feedback', 'nps', 'conversations/sla', 'customers/archived',
  /*
   * Bulk sending, at STORE level.
   *
   * It used to be marketing and head office only, which read as a safety rule
   * and worked as an obstacle: the person who knows which customers have not
   * been in since Diwali is the manager of the shop they used to come to, and
   * they had to ask somebody else to send to them.
   *
   * The level is what makes it safe rather than the absence of the screen. At
   * 'store' a manager's audience preview, and therefore their send, cannot
   * reach past the branches they already run; the approval gate, the consent
   * filter and the archive filter are unchanged and apply to them exactly as
   * they apply to head office.
   */
  'campaigns',
  'payments', 'loyalty/programme',
  'inventory', 'stock-transfers', 'inventory/dead-stock', 'inventory/by-store', 'data/images',
  'settings/team', 'sales-performance', 'settings/targets', 'hrms/payroll',
  /*
   * The employee master, so it can be a sidebar item rather than a card nested
   * on the HR hub. Granted exactly where 'hrms/payroll' is and at the same
   * 'store' depth: a manager reads the record of the people in the branches
   * they already run, and no further.
   *
   * Deliberately NOT added to the API-prefix map below. GET /hrms/employees
   * stays gated on the 'hrms' screen, because other screens lean on it — the
   * reports tab's employee picker among them — and moving the gate would take
   * that endpoint away from roles that hold 'hrms' but not this screen.
   */
  'hrms/employees',
  /*
   * The inbox's quick replies, at STORE level.
   *
   * Deliberately NOT in HEAD_OFFICE_ONLY / HEAD_OFFICE_DELEGABLE, which is
   * where the other "one tenant-wide decision" settings screens sit. Those are
   * global masters — what a design code means, which columns an export carries
   * — and a quick reply is not: it is scoped to one branch or to all of them,
   * and the branch-scoped case is the whole reason the client wanted a table.
   * With eleven shops, a manager who cannot add a shortcut for their own
   * counter means the per-branch half of the feature never gets used.
   *
   * Delegating it would also have been actively wrong. A delegable module
   * raises its holder to HEAD OFFICE for every route under the matched prefix
   * (ModuleAccessGuard), so granting the screen would have let a branch manager
   * write replies every branch reads — the exact split the API enforces at
   * `QuickRepliesService.assertScope`, undone by the mechanism meant to make
   * the screen usable.
   */
  'settings/quick-replies',
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

const ROLE_ACCESS: Record<Role, AccessMap> = {
  salesperson: at('own', SALESPERSON),
  store_manager: at('store', STORE_MANAGER),
  marketing: MARKETING,
  head_office: at('store', [...MODULES]),
  // An area manager is a store manager over SEVERAL branches: same screens at
  // 'store' depth, and the scope layer widens "their store" to every assigned
  // store (plus region roll-up). Revived 7 Oct on the client's ask.
  area_manager: at('store', STORE_MANAGER),
  // Retired role (nobody holds it; not assignable). Kept closed.
  storeperson: at('own', ['hrms', 'catalogue', 'inventory', 'inventory/dead-stock', 'data/images']),
};

/**
 * Screens only head office can use: their APIs are head-office-only (and one of
 * them edits access itself), so they are never given to anybody else.
 */
export const HEAD_OFFICE_ONLY: ModuleSlug[] = [
  'settings/onboarding', 'new-store', 'settings/configuration', 'settings/integrations',
  // Writing a template puts the business's name in a customer's WhatsApp and
  // Meta judges the whole account on what it says. The API behind this screen
  // is @Roles('head_office') already; listing it here keeps the sidebar from
  // offering somebody a page that would 403 on open.
  'settings/integrations/templates',
  /*
   * CHANGING the bot's wording, as distinct from reading it ('bot-script',
   * which every manager holds). It rewords the conversation every branch has
   * with every customer, so it starts where the other irreversible settings do
   * — and, like them, head office can hand it to one person on purpose.
   */
  'bot-script/edit',
  'settings/messaging-routes', 'settings/access',
  // The website catalogue connection and its sync runs: every route behind it
  // is @Roles('head_office') (catalogue-sync.controller.ts).
  'catalogue/integration',
];

/**
 * Of those, the ones head office may hand to somebody else on purpose (client,
 * 14 Oct: "if she wants to give two or three head office screens to someone,
 * she should be able to"). They stay out of every role's defaults — nobody
 * gets them by being promoted — but head office can switch one on for one
 * person, and `ModuleAccessGuard` then lets that person's requests to THAT
 * screen's routes through as head office.
 *
 * `settings/access` is deliberately NOT here. It is the screen that edits
 * access, so granting it would let the holder grant themselves anything,
 * including head office itself. That one stays with head office until the
 * owner asks for it in writing.
 */
export const HEAD_OFFICE_DELEGABLE: ModuleSlug[] = [
  'settings/onboarding',
  'new-store',
  'settings/configuration',
  'settings/integrations',
  'settings/integrations/templates',
  // The marketing team writes the campaign scripts; the owner should not have
  // to become their typist, or hand over all of head office to avoid it.
  'bot-script/edit',
  'settings/messaging-routes',
  // The codes in a design number are the merchandiser's subject, not the
  // owner's. Head office should be able to hand the screen over without
  // handing over head office.
  'settings/product-groups',
  // Which columns the Leads and NPS sheets come out with is the subject of
  // whoever reconciles those sheets against the client's own workbook — a
  // branch manager, not the owner. Delegable for the same reason product
  // groups are: handing the screen over should not mean handing over head
  // office.
  'settings/export-formats',
];

/** The roles in use. Area manager and storeperson are retired: nobody can be given them. */
export const ACTIVE_ROLES: Role[] = ['salesperson', 'store_manager', 'marketing', 'head_office'];

/**
 * A workspace's own rule: its sales staff start with attendance only (Check in
 * / Check out, leave, regularisation) instead of the salesperson defaults. It
 * covers staff added later, which setting each person by hand could not.
 *
 * Switched on per organisation by ATTENDANCE_ONLY_SALES_ORGS, a comma-separated
 * list of organisation ids; unset or empty is off everywhere. Read here and
 * nowhere else, so sign-in, the API guard, People & Access and assignment
 * cannot disagree about it.
 */
export function startsAttendanceOnly(role: Role, organisationId: string | null | undefined): boolean {
  return role === 'salesperson' && !!organisationId && listedOrganisationIds().includes(organisationId);
}

/** The ids the variable lists, as written. */
function listedOrganisationIds(): string[] {
  return (process.env.ATTENDANCE_ONLY_SALES_ORGS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
}

/**
 * For the log at startup: the listed ids that are organisations here, and the
 * ones that are not. An id that matches nothing (mistyped, or pasted with its
 * quotes) leaves the rule off for that workspace, and nothing else would say so.
 */
export async function listedAttendanceOnlyOrgs(
  db: Pick<Prisma.TransactionClient, 'organisation'>,
): Promise<{ on: string[]; unknown: string[] }> {
  const listed = [...new Set(listedOrganisationIds())];
  if (!listed.length) return { on: [], unknown: [] };
  const found = await db.organisation.findMany({ where: { id: { in: listed } }, select: { id: true } });
  const known = new Set(found.map((o) => o.id));
  return { on: listed.filter((id) => known.has(id)), unknown: listed.filter((id) => !known.has(id)) };
}

/** What a role starts with in this organisation, before head office's changes for one person. */
export function roleDefaults(role: Role, organisationId: string | null | undefined): AccessMap {
  const usual = ROLE_ACCESS[role];
  if (!startsAttendanceOnly(role, organisationId)) return { ...usual };
  // Picked out of the role's own screens, so the rule can take screens away but never give one.
  return Object.fromEntries(Object.entries(usual).filter(([slug]) => slug === 'hrms'));
}

/** What this person may open: what their role starts with here, with head office's changes applied. */
export function effectiveAccess(
  role: Role,
  overrides: unknown,
  organisationId: string | null | undefined,
): AccessMap {
  const base = roleDefaults(role, organisationId);
  if (role === 'head_office' || !overrides || typeof overrides !== 'object') return base;
  for (const [slug, v] of Object.entries(overrides as Record<string, unknown>)) {
    if (!(MODULES as readonly string[]).includes(slug)) continue;
    if (v === 'none') delete base[slug];
    else if (v === 'own' || v === 'store') base[slug] = v;
  }
  return base;
}

/**
 * Whether this person can open a screen at all. Asked before a lead or a
 * conversation is given to somebody, so work never sits with a person who
 * cannot see it.
 */
export function canOpen(
  person: { role: Role; accessOverrides: unknown; organisationId: string },
  screen: ModuleSlug,
): boolean {
  return screen in effectiveAccess(person.role, person.accessOverrides, person.organisationId);
}

/**
 * The same question about a person known only by id. Nobody found: no. Somebody
 * who has left, or was never approved: no, because they cannot sign in at all.
 */
export async function canOpenById(
  db: Pick<Prisma.TransactionClient, 'user'>,
  organisationId: string,
  userId: string,
  screen: ModuleSlug,
): Promise<boolean> {
  const person = await db.user.findFirst({
    where: { id: userId, organisationId, isActive: true, approvalStatus: 'approved' },
    select: { role: true, accessOverrides: true, organisationId: true },
  });
  return !!person && canOpen(person, screen);
}

/**
 * Head office's changes for one person, carried over to a new role.
 *
 * A screen switched on at `own` for somebody whose old role did not have it at
 * store level was a gift. Where the new role gives that screen at store level,
 * keeping the entry would hold the person below everybody else in the role: a
 * salesperson given CRM back and then made store manager would see only their
 * own leads. Those entries are dropped. A screen head office switched off, or
 * narrowed on purpose, stays as it is.
 */
export function overridesForNewRole(
  overrides: unknown,
  from: Role,
  to: Role,
  organisationId: string | null | undefined,
): { kept: Record<string, AccessOverride>; dropped: string[] } {
  const before = roleDefaults(from, organisationId);
  const after = roleDefaults(to, organisationId);
  const entries = Object.entries(
    overrides && typeof overrides === 'object' ? (overrides as Record<string, AccessOverride>) : {},
  );
  const dropped = entries
    .filter(([slug, level]) => level === 'own' && after[slug] === 'store' && before[slug] !== 'store')
    .map(([slug]) => slug);
  return { kept: Object.fromEntries(entries.filter(([slug]) => !dropped.includes(slug))), dropped };
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
  ['crm/nps', 'nps'],
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
  /*
   * Your own attendance is not an HR screen.
   *
   * `['hrms','hrms']` below hands the whole /hrms API to the HR hub, so turning
   * that screen off for somebody also stopped them clocking in, reading their
   * own punches, or resolving their store's geofence — observed in production
   * as repeated 403s on GET /hrms/attendance/me and GET /hrms/geofence after a
   * head office tailored a colleague's screens.
   *
   * The HR screen is for seeing OTHER people's attendance. These routes are
   * the person's own and already carry @Permit('self.attendance' | 'self.leave'),
   * which every role holds; null here leaves them to that and to the role
   * checks, exactly as the shared APIs above.
   *
   * Longest prefix wins, so each of these beats the 'hrms' entry. Deliberately
   * NOT listed: bare `hrms/attendance` and `hrms/leave`, which the service
   * widens to the caller's whole scope and which therefore do belong to the
   * screen.
   */
  ['hrms/attendance/me', null],
  ['hrms/attendance/check-in', null],
  ['hrms/attendance/check-out', null],
  ['hrms/geofence', null],
  ['hrms/schedule/me', null],
  ['hrms/regularize', null],
  ['hrms/leave/balances', null],
  ['hrms/leave/preview', null],
  ['hrms/holidays', null],
  ['hrms/shifts', null],
  ['hrms', 'hrms'],
  // Store commission plan + monthly summary live on the Sales Performance screen.
  ['commissions', 'sales-performance'],
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
  /*
   * Quick replies, mapped exactly as lead tags are and for the same reason:
   * one screen owns the vocabulary, while the inbox reads it all day.
   *
   * SOFT is load-bearing here. The two `conversation/...` routes are
   * @Roles('salesperson') because the person tapping a chip is the person with
   * the customer; a hard mapping would refuse them for not holding a settings
   * screen, and the chip row would come back empty for everybody on the floor.
   * Somebody who DOES hold the screen is served at their own level, so a
   * salesperson head office granted it edits as a store manager would.
   *
   * Longer prefixes win in BY_LENGTH, so this beats ['crm/conversations', …].
   */
  ['crm/quick-replies', 'settings/quick-replies'],
  /*
   * Mapped to the TEMPLATES screen, not to Conversations.
   *
   * The controller is @Roles('head_office') as a whole, and the templates page
   * reads it to find the WhatsApp Business Account id — without which the
   * composer disables itself. Pointed at 'conversations' the delegation was
   * useless: head office switched Message Templates on for somebody, the
   * screen opened, this call 403'd, and "New template" stayed dead with no
   * explanation. Reported from production on 16 Nov.
   *
   * Nobody loses anything. Whoever does not hold the templates screen falls
   * through to the route's own @Roles exactly as before.
   */
  ['integrations-registry', 'settings/integrations/templates'],
  /*
   * The store-wise stock API, governed by the SCREEN that shows it.
   *
   * Without this it falls to ['stock','inventory'] below, so somebody granted
   * "Stock by Store" and not "Inventory & Stock" would see the page and get a
   * 403 from it — the same mismatch between what a screen is given and what
   * its routes demand that broke the delegated bot-script and template
   * screens. SOFT, so anybody holding plain `inventory` is unaffected and
   * still meets the route's own @Permit.
   */
  ['stock/by-store', 'inventory/by-store'],
  /*
   * The APIs behind the head-office screens head office may delegate. SOFT, so
   * somebody who does NOT hold the screen is unaffected and still meets the
   * route's own @Roles -- /config/bootstrap stays open to everyone. Somebody
   * who DOES hold it is raised to head office for these routes only, which is
   * what makes a delegated screen actually usable instead of a page that 403s
   * the moment it opens.
   */
  ['config', 'settings/configuration'],
  ['integrations', 'settings/integrations'],
  ['omnichannel/templates', 'settings/integrations/templates'],
  ['omnichannel/integrations', 'settings/integrations/templates'],
  /*
   * The bot script's own two paths, which carry BOTH the open read and the
   * head-office write. SOFT is what keeps those apart without the route table
   * needing to know the method: somebody who does not hold 'bot-script/edit'
   * passes straight through to each route's own @Roles, so GET stays open to a
   * salesperson picking up a handed-off thread and PUT still refuses them.
   * Somebody who DOES hold it is raised to head office here, which is the only
   * reason a delegated script screen can save anything.
   *
   * Longer prefixes win in BY_LENGTH, so these beat ['crm/qualification','crm']
   * above and the rest of that controller keeps its CRM scoping.
   */
  ['crm/qualification/bot-script', 'bot-script/edit'],
  ['crm/qualification/bot-default', 'bot-script/edit'],
  /*
   * Campaign conversations live on the Bot Scripts screen and ARE bot script —
   * "what the bot replies when a customer arrives from this ad". Saving one is
   * @Roles('head_office'), and without this the route fell to the generic
   * 'crm' mapping, which raised a delegated editor only as far as store
   * manager and then 403'd them. The client reported exactly that: edit access
   * granted, "Add campaign" unusable.
   */
  ['crm/qualification/adset-rules', 'bot-script/edit'],
  /*
   * The product-group screen's own API. @Roles('head_office') like the rest of
   * the delegable screens, so without this a delegated holder would open the
   * page and be refused by it.
   */
  ['product-groups', 'settings/product-groups'],
  /*
   * The export-format screen's own API — and ONLY it.
   *
   * Deliberately `crm/exports/formats` and not `crm/exports`. The prefix is
   * shared with `crm/exports/leads.xlsx`, and because a delegable module raises
   * the holder to head office for the whole matched prefix, the wider mapping
   * would have let somebody granted a column-layout screen download every
   * branch's leads — `LeadExportService` scopes that file from `user.role`.
   * Longer prefixes win in BY_LENGTH, so the download keeps its CRM scoping.
   */
  ['crm/exports/formats', 'settings/export-formats'],
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
