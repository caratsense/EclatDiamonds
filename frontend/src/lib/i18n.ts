"use client";

import { useCallback } from "react";
import { create } from "zustand";

/**
 * Lightweight in-repo i18n (phase 1: nav + onboarding chrome only).
 * No i18n library — a plain dictionary + a persisted zustand store for the
 * active language. English is the default and the universal fallback: any key
 * missing from the active language renders the caller's English fallback (or,
 * failing that, the key itself), so an untranslated string is never blank.
 */
export type Lang = "en" | "hi";

const LANG_KEY = "eclat.lang";

/**
 * Read the chosen language. SSR-safe (returns the "en" default on the server).
 * Mirrors the manual, `typeof window`-guarded localStorage helpers in lib/api.ts
 * rather than zustand's persist middleware (which the codebase doesn't use).
 */
function getStoredLang(): Lang {
  if (typeof window === "undefined") return "en";
  const value = window.localStorage.getItem(LANG_KEY);
  return value === "hi" || value === "en" ? value : "en";
}

function setStoredLang(lang: Lang) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LANG_KEY, lang);
}

interface LangState {
  lang: Lang;
  setLang: (lang: Lang) => void;
}

/**
 * useLang — the active UI language. Like use-session, it's a plain zustand
 * store; persistence is manual (localStorage["eclat.lang"]) so it stays in the
 * same shape as the rest of the app. Defaults to "en" and survives reloads.
 * Every language-aware component lives behind SessionGate (client-only), so
 * reading storage in the initializer can't cause an SSR hydration mismatch.
 */
export const useLang = create<LangState>((set) => ({
  lang: getStoredLang(),
  setLang: (lang) => {
    setStoredLang(lang);
    set({ lang });
  },
}));

/**
 * Translation dictionary. Keys are dotted namespaces:
 *  - `group.<Label>`  — sidebar / mobile section headers (English label = key tail)
 *  - `nav.<slug>`     — nav item titles, keyed by route slug
 *  - `action.*`       — common actions
 *  - `menu.*`         — user-menu items
 *  - `tour.*`         — first-run welcome tour
 * Hindi is written to read naturally for retail store staff (Hinglish loanwords
 * kept where that's how the terms are actually spoken), not machine-literal.
 */
export const DICT: Record<Lang, Record<string, string>> = {
  en: {
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
    "action.language": "Language / भाषा",

    // User menu
    "menu.profile": "Profile & Settings",
    "menu.tour": "Show welcome tour",

    // Welcome tour
    "tour.welcome.title": "Welcome, {name}.",
    "tour.welcome.body":
      "CaratSense keeps your store's sales, customers, orders and attendance in one place.",
    "tour.where.title": "Where you are",
    "tour.where.body":
      "Use the store switcher in the top bar to change stores — everything you see is scoped to the selected store (right now, {store}). The sidebar on the left groups your tools by area.",
    "tour.start.title": "Start here",
    "tour.start.prefix": "As {role}:",
    "tour.start.roleFallback": "a team member",
    "tour.start.salesperson":
      "Add a lead in CRM, build a Quote, and mark your attendance for the day.",
    "tour.start.store_manager":
      "Check your dashboard, clear approvals, and file the daily report (DSR).",
    "tour.start.manager":
      "Open the Dashboards, compare branches in Store Comparison, and action Approvals across stores.",
    "tour.start.default":
      "Start from your dashboard, then open any module from the sidebar.",
    "tour.tip.title": "A quick tip",
    "tour.tip.body":
      "Hover any sidebar item to see what it does. You can reopen this tour any time from the menu under your avatar (top-right).",
    "tour.skip": "Skip",
    "tour.back": "Back",
    "tour.next": "Next",
    "tour.getStarted": "Get started",
  },
  hi: {
    // Sidebar / mobile section headers
    "group.Overview": "अवलोकन",
    "group.Sales": "बिक्री",
    "group.Operations": "संचालन",
    "group.People": "स्टाफ",
    "group.Management": "प्रबंधन",
    "group.Back-office": "बैक-ऑफिस",
    "group.Administration": "प्रशासन",

    // Nav items (keyed by slug)
    "nav.dashboards": "डैशबोर्ड",
    "nav.reporting": "रिपोर्ट और DSR",
    "nav.store-comparison": "स्टोर तुलना",
    "nav.crm": "CRM और लीड्स",
    "nav.checkins": "चेक-इन और फुटफॉल",
    "nav.reminders": "रिमाइंडर",
    "nav.quotation": "कोटेशन और ऑर्डर",
    "nav.catalogue": "कैटलॉग",
    "nav.returns": "रिटर्न और एक्सचेंज",
    "nav.discounts": "डिस्काउंट",
    "nav.loyalty": "लॉयल्टी और रेफरल",
    "nav.sales-performance": "सेल्स परफॉर्मेंस",
    "nav.inventory": "इन्वेंटरी और स्टॉक",
    "nav.hrms": "HRMS और हाज़िरी",
    "nav.finance": "फाइनेंस और फंड प्लानिंग",
    "nav.new-store": "नया स्टोर सेटअप",
    "nav.marketing": "मार्केटिंग",
    "nav.approvals": "मंज़ूरी",
    "nav.ticketing": "टिकटिंग",
    "nav.settings/stores": "स्टोर सेटअप",
    "nav.more": "अधिक",

    // Common actions
    "action.save": "सेव करें",
    "action.cancel": "रद्द करें",
    "action.signOut": "साइन आउट",
    "action.language": "Language / भाषा",

    // User menu
    "menu.profile": "प्रोफ़ाइल और सेटिंग्स",
    "menu.tour": "वेलकम टूर दिखाएं",

    // Welcome tour
    "tour.welcome.title": "स्वागत है, {name}।",
    "tour.welcome.body":
      "CaratSense आपके स्टोर की बिक्री, ग्राहक, ऑर्डर और हाज़िरी — सब एक ही जगह रखता है।",
    "tour.where.title": "आप कहाँ हैं",
    "tour.where.body":
      "ऊपर बार में दिए स्टोर स्विचर से स्टोर बदलें — आप जो भी देखते हैं वह चुने गए स्टोर के हिसाब से दिखता है (अभी: {store})। बाईं ओर का साइडबार आपके टूल्स को काम के हिसाब से समूहों में रखता है।",
    "tour.start.title": "यहाँ से शुरू करें",
    "tour.start.prefix": "{role} के तौर पर:",
    "tour.start.roleFallback": "टीम सदस्य",
    "tour.start.salesperson":
      "CRM में लीड जोड़ें, कोटेशन बनाएं, और दिन की हाज़िरी लगाएं।",
    "tour.start.store_manager":
      "अपना डैशबोर्ड देखें, मंज़ूरी वाले काम निपटाएं, और रोज़ की रिपोर्ट (DSR) भरें।",
    "tour.start.manager":
      "डैशबोर्ड खोलें, स्टोर तुलना में ब्रांच की तुलना करें, और सभी स्टोर की मंज़ूरी निपटाएं।",
    "tour.start.default":
      "अपने डैशबोर्ड से शुरू करें, फिर साइडबार से कोई भी मॉड्यूल खोलें।",
    "tour.tip.title": "एक छोटा सुझाव",
    "tour.tip.body":
      "किसी भी साइडबार आइटम पर माउस ले जाएं तो उसका काम दिखेगा। इस टूर को आप कभी भी ऊपर-दाईं ओर अपने अवतार के मेन्यू से दोबारा खोल सकते हैं।",
    "tour.skip": "छोड़ें",
    "tour.back": "पीछे",
    "tour.next": "आगे",
    "tour.getStarted": "शुरू करें",
  },
};

/**
 * useT — returns a translator bound to the active language.
 * `t(key, fallback?)` resolves `DICT[lang][key]`, then the English `fallback`,
 * then the raw key. Callers pass the existing English string as the fallback so
 * every untranslated key still renders English.
 */
export function useT() {
  const lang = useLang((s) => s.lang);
  return useCallback(
    (key: string, fallback?: string): string =>
      DICT[lang][key] ?? fallback ?? key,
    [lang],
  );
}
