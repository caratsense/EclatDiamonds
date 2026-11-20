# CaratSense Frontend (Eclat)

Unified operations frontend for a multi-store jewelry retail business. Ships as
a PWA serving one codebase to in-store terminals, store/area/HO dashboards, and
the mobile geo-attendance app. Talks to the NestJS backend over its API — never
the DB directly.

> This is the **Phase 1 scaffold**: the app shell + a navigable page for all
> **17 modules** with placeholder content. See [Phase 2 plan](#phase-2-plan).

## Stack

- **Next.js 16** (App Router, Turbopack) + **React 19** + **TypeScript 5** (strict)
- **Tailwind CSS v4** (`@tailwindcss/postcss`) + shadcn/ui-style components on **Radix**
- **lucide-react** icons, **next-themes** (light default)
- **@tanstack/react-query** + **axios** (API), **zustand** (session/store context)
- **react-hook-form** + **zod**, **recharts**, **sonner** toasts, **date-fns**
- `class-variance-authority` + `clsx` + `tailwind-merge`

## Run

```bash
npm install
cp .env.example .env.local   # set NEXT_PUBLIC_API_URL (default http://localhost:4000)
npm run dev                  # http://localhost:3000  (→ redirects to /dashboards)
```

Other scripts: `npm run build`, `npm start`, `npm run lint`, `npx tsc --noEmit`.

## Structure

```
src/
  app/
    layout.tsx            # root layout: fonts, <Providers>
    page.tsx              # / → redirect to /dashboards
    (app)/
      layout.tsx          # wraps every module in <AppShell>
      <module>/page.tsx   # 17 thin pages → <SectionPlaceholder slug="..." />
  components/
    layout/               # sidebar, topbar, store-switcher, role-badge, user-menu, theme-toggle, mobile-nav, app-shell
    section/              # section-header, coming-soon, section-placeholder
    ui/                   # shadcn primitives (button, card, input, select, table, tabs, dialog, dropdown-menu, badge, avatar, separator, skeleton, sonner, label)
    providers.tsx         # react-query + theme + toaster
  lib/
    navigation.ts         # single source of truth for nav groups + section metadata
    types.ts              # Role, Store, User, Session + role rank/labels
    format.ts             # ₹ INR, grams, carats, purity helpers
    api.ts                # axios instance (NEXT_PUBLIC_API_URL)
    utils.ts              # cn()
    mock/                 # seed data until the backend exists
  store/
    use-session.ts        # zustand: { user, role, currentStore, stores[] } + setters
```

### Cross-cutting concepts (baked into the scaffold)

- **Multi-store context is always present.** The topbar store switcher drives
  `useSession().currentStore`; every section header shows the active store.
- **Role-aware UI.** `useSession().role` (Salesperson → Store Manager → Area
  Manager → Head Office) is shown in the role badge and is switchable to demo
  role-based views. Each page carries a `// role/store-scoped` seam.
- **Money/weights** render via `lib/format.ts` (₹, grams, carats) for consistent
  precision/units.

## Modules (routes)

| # | Route | Module |
|---|-------|--------|
| 1 | `/crm` | CRM & Leads |
| 2 | `/quotation` | Quotation & Pricing |
| 5 | `/catalogue` | Catalogue (AI image search) |
| 14 | `/returns` | Returns & Exchange |
| 15 | `/discounts` | Discounts |
| 17 | `/loyalty` | Loyalty & Gold Scheme |
| 8 | `/timelines` | Timelines & Status |
| 9 | `/inventory` | Inventory & Stock |
| 12 | `/payments` | Payments |
| 6 | `/hrms` | HRMS & Attendance |
| 7 | `/checkins` | Check-ins & Footfall |
| 3 | `/dashboards` | Dashboards (default landing) |
| 4 | `/finance` | Finance & Fund Planning |
| 10 | `/reporting` | Reporting & DSR |
| 11 | `/new-store` | New-Store Setup |
| 16 | `/marketing` | Marketing |
| 13 | `/ticketing` | Ticketing |

## Phase 2 plan

Flesh out each section against the real backend:

1. **Auth + session hydration** — replace mock `useSession` seed with the
   `auth/me` endpoint; gate visible stores/roles by real assignment.
2. **API wiring** — add the axios interceptor (auth token + `X-Store-Id`),
   replace `lib/mock/*` with react-query hooks per module.
3. **Role-based rendering** — drive component visibility from `ROLE_RANK`
   (e.g. discount limits, all-stores aggregate views for area/HO).
4. **PWA** — add `manifest.ts`, service worker, offline tolerance for terminals,
   and browser geolocation for Module 6 attendance.
5. **Channel actions** — WhatsApp-share for quotes/catalogues (Modules 2/5),
   terminal-friendly large-target layouts.
6. **Per-module screens** — CRM pipeline, quote builder, catalogue + AI image
   search, DSR charts (recharts), timelines, inventory tables, etc.

Per project convention, create `docs/modules/NN-<slug>.md` when starting real
work on a module.
