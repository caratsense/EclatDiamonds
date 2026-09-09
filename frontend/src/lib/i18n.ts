"use client";

import { useCallback } from "react";

import { useConfigBootstrap } from "@/lib/queries/tenant-config";

/**
 * In-repo label dictionary for the app chrome (sidebar, mobile nav, user menu).
 *
 * The product ships in English only — one language, everywhere, so a manager
 * reading over someone's shoulder is looking at the same words on both screens
 * and a screenshot in a WhatsApp group means the same thing to whoever opens it.
 * There was a Hindi option here; it was removed with the labels below rewritten
 * in plain English instead. If a second language is ever wanted, reintroduce the
 * language store here — `useT` already resolves through a lookup, so no caller
 * would need to change.
 */

/**
 * Chrome labels, keyed by dotted namespace:
 *  - `group.<Label>` — sidebar / mobile section headers
 *  - `nav.<slug>`    — nav item titles, keyed by route slug
 *  - `action.*`      — common actions
 *  - `menu.*`        — user-menu items
 */
export const DICT: Record<string, string> = {
  // Sidebar / mobile section headers
  "group.Overview": "Overview",
  "group.Sales": "Sales",
  "group.Operations": "Operations",
  "group.People": "People",
  "group.Management": "Management",
  "group.Back-office": "Back-office",
  "group.Administration": "Administration",

  // Nav items (keyed by slug)
  "nav.dashboards": "Dashboards",
  "nav.reporting": "Reporting & DSR",
  "nav.store-comparison": "Store Comparison",
  "nav.crm": "CRM & Leads",
  "nav.checkins": "Check-ins & Footfall",
  "nav.reminders": "Reminders",
  "nav.quotation": "Quotation & Orders",
  "nav.catalogue": "Catalogue",
  "nav.returns": "Returns & Exchange",
  "nav.discounts": "Discounts",
  "nav.loyalty": "Loyalty & Referral",
  "nav.sales-performance": "Sales Performance",
  "nav.inventory": "Inventory & Stock",
  "nav.hrms": "HRMS & Attendance",
  "nav.finance": "Finance & Fund Planning",
  "nav.new-store": "New-Store Setup",
  "nav.marketing": "Marketing",
  "nav.approvals": "Approvals",
  "nav.ticketing": "Ticketing",
  "nav.settings/stores": "Store Setup",
  "nav.more": "More",

  // Common actions
  "action.save": "Save",
  "action.cancel": "Cancel",
  "action.signOut": "Sign out",

  // User menu
  "menu.profile": "Profile & Settings",
  "menu.tour": "Show the quick guide",
  "menu.installApp": "Install app",
};

/**
 * useT — resolves a chrome label. `t(key, fallback?)` returns the dictionary
 * entry, then the caller's inline English, then the raw key, so a missing key
 * still renders something readable rather than a blank.
 *
 * ## The tenant's own vocabulary wins
 *
 * The resolved English is then looked up in this tenant's industry lexicon,
 * which is keyed by the neutral string itself: a clinic's bootstrap carries
 * `{"Customers": "Patients", "CRM & Leads": "CRM & Enquiries"}`, so the sidebar
 * and every section header say Patients without a single screen knowing that
 * healthcare exists.
 *
 * Substitution is an exact, whole-string match — never a word replacement — so
 * the only labels that can change are the short list the backend chose to emit.
 * "Customer support" is not a key and stays as it is.
 *
 * Jewellery declares no lexicon, so the map is empty and every lookup misses:
 * Eclat renders exactly the dictionary above, unchanged.
 */
export function useT() {
  const { data } = useConfigBootstrap();
  const labels = data?.labels;
  return useCallback(
    (key: string, fallback?: string): string => {
      const neutral = DICT[key] ?? fallback ?? key;
      return labels?.[neutral] ?? neutral;
    },
    [labels],
  );
}
