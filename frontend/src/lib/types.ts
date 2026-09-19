/**
 * Core domain types shared across the app.
 * Multi-store scoping and the role hierarchy are first-class concepts
 * (see CLAUDE.md): almost every entity is store-scoped and rendered
 * differently per role.
 */

export type Role =
  | "salesperson"
  | "storeperson"
  | "store_manager"
  | "area_manager"
  | "head_office"
  /** One per store: CRM, marketing and inbound, own attendance and leave. */
  | "marketing";

export const ROLE_LABELS: Record<Role, string> = {
  salesperson: "Salesperson",
  storeperson: "Storeperson",
  store_manager: "Store Manager",
  area_manager: "Area Manager",
  head_office: "Head Office",
  marketing: "Marketing",
};

/** The roles in use. Area manager and storeperson are retired: nobody can be given them. */
export const ACTIVE_ROLES: Role[] = ["salesperson", "store_manager", "marketing", "head_office"];

/**
 * How far a person may go in one screen: `own` = their own records, `store` =
 * the whole of their store, as a manager. From the server (auth/access.ts):
 * the role's defaults with head office's per-person changes applied.
 */
export type AccessLevel = "own" | "store";
export type AccessMap = Record<string, AccessLevel>;

/**
 * Role rank — higher number == broader scope/visibility.
 *
 * A storeperson shares the front-line tier for delegation, but what they can
 * open is decided by explicit lists (navigation `roles`, server permissions),
 * never by `ROLE_RANK >= ROLE_RANK.salesperson`.
 */
export const ROLE_RANK: Record<Role, number> = {
  salesperson: 1,
  storeperson: 1,
  store_manager: 2,
  area_manager: 3,
  head_office: 4,
  marketing: 1,
};

export interface Store {
  id: string;
  /** e.g. "Surat — Main" */
  name: string;
  city: string;
  /** true for the synthetic "All Stores" aggregate option. */
  isAggregate?: boolean;
}

export interface User {
  id: string;
  name: string;
  email: string;
  /** Initials for avatar fallback. */
  initials: string;
  /** How to reach them — the only details a person edits themselves. */
  phone?: string | null;
  contactEmail?: string | null;
}

export interface Session {
  user: User;
  role: Role;
  /** Screens this person may open (absent until the session is hydrated). */
  access?: AccessMap;
  currentStore: Store;
  stores: Store[];
}
