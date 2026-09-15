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
  | "head_office";

export const ROLE_LABELS: Record<Role, string> = {
  salesperson: "Salesperson",
  storeperson: "Storeperson",
  store_manager: "Store Manager",
  area_manager: "Area Manager",
  head_office: "Head Office",
};

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
}

export interface Session {
  user: User;
  role: Role;
  currentStore: Store;
  stores: Store[];
}
