# Eclat / CaratSense — Project Handover

> For a developer joining the project. Read this once end-to-end, then keep §4
> (getting running) and §12 (gotchas) to hand.
> Written 2026-08-21 against `main` @ `9589ac5`. If that's far behind what you
> see, treat the *structure* here as reliable and re-check the *status* claims.

---

## 1. What this is

**Eclat** (product name **CaratSense**) is a unified operations platform for a
**multi-store jewellery retail chain** — sales, inventory, finance, HR, CRM and
customers across every branch in one system.

Two things about it that shape everything else:

**It is not greenfield.** The client already runs a jewellery ERP called
**APRS-SJEP** (often called **Gati**, SQL Server, on-site). Eclat does not
replace it overnight — it sits alongside, syncing data out of it. Read
`docs/DATA_PIPELINE.md` and `docs/GATI_DATA_CONTRACT.md` before touching
anything sync-related.

**Multi-store is a first-class concept, not a feature.** Almost every table has
a `storeId`, and almost every query is scoped by the caller's role and store
assignments. Getting this wrong leaks one branch's revenue into another's
dashboard. `docs/MULTI_STORE.md` is the contract; §5 below is the short version.

The client is a real jewellery business (Éclat Diamonds, eclatdiamonds.in), so
domain details matter: gold karats, making charges, old-gold exchange, HUID
hallmarking, diamond rates, GST. `jewelry-domain-expert` context lives in
`docs/CLIENT-CALL-2026-07.md` and the `CLIENT-NOTES-*` files — those are the
authoritative record of what the owner actually asked for.

---

## 2. Where things stand

**The application is feature-complete for go-live.** `docs/PRODUCTION_READINESS.md`
(2026-08-13) is the honest status document — read it. Summary:

- All 17 modules are built and wired to a real backend (no mock data left).
- Multi-store isolation audited, no cross-store leak.
- ~195 backend tests pass across 23 e2e spec files; both TypeScript projects clean.
- What's left is mostly **not code**: live-Gati execution on the client's machine,
  and a set of client-supplied facts and credentials.

**In flight right now:**

| | Status |
|---|---|
| WhatsApp reporting bot | **PR #2 open** — see `docs/WHATSAPP-BOT.md` |
| Google sign-in hardening | Merged to `main` |
| Catalogue visual similarity (DINOv2 + SigLIP 2) | Merged — includes a new Python `inference/` service |

---

## 3. Stack & repo layout

| Part | What |
|---|---|
| **Backend** | NestJS 11, Prisma 6, PostgreSQL. `backend/` |
| **Frontend** | Next.js 16, React 19, TypeScript, Tailwind v4, shadcn/ui. `frontend/` |
| **Inference** | Python CPU microservice, DINOv2 + SigLIP 2 image embeddings for catalogue search. `inference/` |
| **Sync agent** | Python, runs on the client's Gati machine, pushes legacy data up. `synceclatcaratsense/` (current) — `data_sync/` is the older version |
| **Docs** | `docs/` — see §13 for the map |

> ⚠️ The Next.js version here has **breaking changes vs. what you may know**.
> `frontend/AGENTS.md` says it plainly: read the relevant guide in
> `node_modules/next/dist/docs/` before writing frontend code.

Backend is organised as one NestJS module per domain — `backend/src/{auth, leads,
quotes, stock, reporting, hrms, notifications, whatsapp-bot, …}` (37 of them).
Shared cross-cutting services live in `backend/src/common/`.

---

## 4. Getting running (day 1)

**Prerequisites:** Node, PostgreSQL 18 (that's what everything was built against),
and Git.

```bash
# 1. Database — create it once
psql -U postgres -c "CREATE DATABASE eclat_dev;"

# 2. Backend
cd backend
npm install
cp .env.example .env          # then fill it in — see below
npx prisma migrate deploy     # apply all migrations
npx prisma generate           # generate the typed client
node prisma/seed.mjs          # demo users, stores, products
npm run start:dev             # → http://localhost:4000

# 3. Frontend (separate terminal)
cd frontend
npm install
# create .env.local with NEXT_PUBLIC_API_URL="http://localhost:4000"
npm run dev                   # → http://localhost:3000
```

**Minimum `.env` to boot** (`backend/.env`, gitignored):

```
DATABASE_URL="postgresql://postgres:<pw>@localhost:5432/eclat_dev?schema=public"
PORT=4000
JWT_SECRET="<48+ random chars>"   # app REFUSES to boot without this
CORS_ORIGINS="http://localhost:3000"
STORAGE_PROVIDER="local"
UPLOAD_DIR="uploads"
```

Every integration (WhatsApp, Razorpay, email, gold rate, AI) **degrades to a
logged no-op** when its keys are absent. The app runs identically with or
without them — you only need credentials for the specific thing you're working on.

**When you pull and something breaks:** 9 times out of 10 it's a stale Prisma
client or an unapplied migration. Run `npm install && npx prisma migrate deploy
&& npx prisma generate`. A wall of TypeScript errors about fields that
"don't exist" on a model is exactly this, not broken code.

**Useful:** `npm run db:studio` opens Prisma Studio at `:5555` — the fastest way
to look at and edit data.

---

## 5. The two concepts you must internalise

### Roles

```
salesperson (1) → store_manager (2) → head_office (4)
```

`area_manager` (3) **still exists in the enum but is dead** — it was collapsed
into `store_manager` in Aug 2026 (migration
`20260808120000_collapse_area_manager_into_store_manager`). The enum value was
deliberately kept so historical audit rows stay valid, but nobody is assigned it
and `ASSIGNABLE_ROLES` is `['salesperson', 'store_manager']`. **Don't write new
code that branches on `area_manager`.**

Rank is numeric (`backend/src/common/role.util.ts`, mirrored in
`frontend/src/lib/types.ts` — kept in sync by hand, no shared package). Guards
admit anyone **at or above** the minimum required rank, so
`@Roles('store_manager')` also admits head_office.

### Store scoping — `StoreScopeService`

This is the **single** authorization mechanism. `backend/src/common/store-scope.service.ts`.

- `resolveScope(userId, role)` → `{ storeIds, allStores }`. head_office gets
  `allStores: true`; everyone else gets their `UserStore` links.
- `storeFilter(user, requestedStoreId)` → a Prisma `where` fragment.
- `assertStoreAllowed(user, storeId)` → throws if out of scope. **Gate every write with this.**

The frontend sends the active store as an `X-Store-Id` header; `@StoreHeader()`
reads it. There is a synthetic "All Stores" aggregate row for broad roles.

**If you find yourself writing an authorization check by hand, stop.** It belongs
in `StoreScopeService`, and duplicating it is how leaks happen.

### Auth, briefly

Hand-rolled JWT — no Passport, no NextAuth. Three global guards in
`app.module.ts`: `JwtAuthGuard` (every route unless `@Public()`), `RolesGuard`,
`ThrottlerGuard`. The guard **re-reads role and `isActive` from the DB on every
request**, so deactivation and role changes take effect immediately regardless of
what the token says. Token is a 30-day bearer in `localStorage`.

Sign-in paths: **Google** (verified locally against Google's JWKS, keyed on the
immutable `googleSub`, never auto-provisions) and **email + password**. WhatsApp
OTP login was **removed** in `ad273be` — don't be confused by leftover references.

---

## 6. The 17 modules

Full spec: `docs/MODULES.md`. All are built. Frontend routes under
`frontend/src/app/(app)/`.

CRM & leads · Quotation & pricing · Dashboards & collaboration · Finance ·
Catalogue (+ AI image search) · HRMS & geo-attendance · Check-ins & footfall ·
Timelines · Inventory & stock transfers · Reporting & DSR · New-store setup ·
Payments · Ticketing · Returns & exchange · Discounts · Marketing · Loyalty.

**Dropped from scope:** CCTV/camera footfall analytics (Module 7 is manual
check-ins only). Don't build it.

Some domain rules worth knowing early, because they're counter-intuitive:
- **Gold is never discounted.** Discounts apply to diamond value and making charges only.
- **Store managers never see cost price** (`canSeeCost` in `role.util.ts`).
- Old gold: 100% exchange value, **80% buyback**.

---

## 7. Data & the legacy system

Two flows:

**One-time backfill** — restore an `APRSSJEP.bak` into a throwaway SQL Server,
ETL history into Postgres. `backend/scripts/backfill-legacy.mjs`.

**Ongoing sync** — `synceclatcaratsense/` runs on the client's Gati machine and
pushes changed rows up on a watermark. Key mappings: `StyleMst` → `Product`,
`Inward` → `StockItem`, `PartyMst` → `Party`, `JewelTrans` → `Sale`. Everything
is keyed on `legacyId` so re-runs upsert rather than duplicate.

**The live risk here** is per-branch attribution (OP-20): sales and orders have
no location column in the legacy schema, so branch has to be derived via
`BookNo → BookMaster`. If the client's install doesn't keep per-branch document
series, per-branch revenue isn't derivable from this data. Needs the live DB to
confirm.

---

## 8. Integrations — status

| Integration | State |
|---|---|
| **WhatsApp Cloud API** | Live in dev. Bot is PR #2. See `docs/WHATSAPP-BOT.md` |
| **Google sign-in** | Merged and working |
| **Razorpay** | Code complete, **no credentials** — dry-run |
| **Email (SMTP)** | Code complete, **no credentials** — dry-run |
| **Gold rate feed** | Code complete, auto-refreshes when a feed URL is set; falls back to last stored rate |
| **Image embeddings** | `inference/` service, deployable to Railway |
| **Object storage** | Local disk in dev; R2 in prod (`STORAGE_PROVIDER`) |

**OP-18 is the standing blocker for client delivery**: WhatsApp, SMTP, Razorpay
and gold-rate credentials are all absent on the Railway deploy, so every send is
a logged no-op. That needs accounts, not code.

---

## 9. Deployment

- **Backend + Postgres** → Railway. Migrations run via `preDeployCommand` in
  `railway.json`, *not* in the Dockerfile CMD.
- **Frontend** → Vercel.
- **Images** → Cloudflare R2 (URLs only in Postgres, never binaries).
- **Inference** → its own Railway service.
- **Sync agent** → Windows Task Scheduler on the client's Gati machine.

Runbook: `docs/DEPLOYMENT.md` and `docs/GO_LIVE.md`.

Domains: `eclatdiamonds.in` is the live client marketing site (Hostinger/nginx —
**not** ours to deploy to). `app.caratsense.in` / `api.caratsense.in` are
documented but not currently resolving.

---

## 10. Testing

```bash
cd backend && npm run test:e2e     # 23 spec files, ~195 tests
npx tsc --noEmit -p tsconfig.json  # backend typecheck
cd frontend && npx tsc --noEmit    # frontend typecheck
```

Tests are backend e2e (Jest + supertest) hitting a real database. **There is no
frontend test harness** — don't go looking for one.

Two habits worth adopting:
1. **Before blaming your change for a failing test, check it fails on `main` too.**
   There are a few long-standing failures unrelated to current work.
2. Tests share the seeded demo users. If you repoint a seeded user's email for
   your own testing, you *will* break the suite — several specs hardcode
   `head.office@caratsense.in` and `password123`.

---

## 11. What's pending

### Needs the client (not code)
Tracked as OP-numbers in `docs/DECISIONS.md`, which is the authoritative list:

- **OP-18** — live credentials for WhatsApp / SMTP / Razorpay / gold-rate. The delivery blocker.
- **OP-12** — owner's email for report delivery.
- **OP-8 / OP-10** — diamond rate table; confirmed store-manager discount caps.
- **OP-11** — HRMS incentive thresholds.
- **OP-17** — confirm special-request amount thresholds (₹25k / ₹1L are assumptions).
- **OP-13** — whether per-client module toggles are a real product requirement.

### Needs the live Gati machine
- **OP-6** — verify legacy status-code decodes against real data.
- **OP-20** — which column is authoritative for branch attribution; whether sales can be attributed at all.
- Confirm one shared DB vs per-store DBs (topology B is not supported today).

### Code still to write
- **WhatsApp bot frontend** — no UI to link a number or revoke one. Highest-value next task; the three backend endpoints already exist. See `docs/WHATSAPP-BOT.md` §9.
- **DSR compliance grid** — store × 7-day view of who hasn't reported.
- **Evening nudges** — needs a Meta-approved message template (1–3 day approval).
- **OP-19** — scheduled nightly DSR send, blocked on OP-12 + OP-18.
- **OP-15** — selfie-on-punch, approver delegation, stale-approval escalation. All need a client call first.

### Known debt
- `ROLE_RANK` duplicated backend/frontend with no shared package — silent divergence risk.
- 30-day JWTs in `localStorage`, no refresh token, no server-side revocation list. A `tokenVersion` column would be nearly free since the guard already reads the user per request.
- Some `@Roles(...)` decorators still list `area_manager`. Harmless (rank maths makes it a no-op) but should be cleaned up.
- **OP-16** — Redis becomes necessary the moment the API runs more than one replica (notifications bus is in-memory today).

---

## 12. Gotchas

**Environment**
- `JWT_SECRET` must be ≥16 chars or the app won't boot. Deliberate.
- `.env` is gitignored; `.env.example` is the committed template. Never commit real secrets.
- Prisma engine files get locked on Windows — stop running backends before `prisma generate`, or you'll get `EPERM`.
- `NEXT_PUBLIC_*` vars are inlined at **build** time. Changing one needs a full frontend restart, not a hot reload.

**Database**
- Migrations are hand-timestamped (`YYYYMMDDHHMMSS_name`) — newer ones were authored manually rather than generated. Match the convention.
- `prisma migrate dev` is interactive and fails in non-interactive shells. Write the migration SQL by hand and use `migrate deploy`.
- Use `Prisma.DbNull` (not JS `null`) to clear a Json column.

**Conventions**
- Record scope decisions in `docs/DECISIONS.md` — that's a project rule from `CLAUDE.md`, not a suggestion.
- Never touch `SJEP DATA/` or `SJEP BACKUP/` — live DB and backups.
- Money is `Decimal` in Prisma. Don't do float arithmetic on rupees.
- Store-scoped tables need `storeId` on the model **and** the scope check in the service. Both.

**Git**
- Work on a branch off `main`, never commit to `main` directly.
- Check `git config user.email` is your **work** address before your first commit — GitHub attributes by email, and a personal address on a work commit means rewriting history later.

---

## 13. Doc map — where to look

| File | Read it when |
|---|---|
| `CLAUDE.md` | First. Project rules and conventions |
| `docs/PRODUCTION_READINESS.md` | You want the honest current status (most current status doc) |
| `docs/MODULES.md` | You need the spec for a module |
| `docs/DECISIONS.md` | "Why is it like this?" / logging a new decision. Also the OP-number open list |
| `docs/MULTI_STORE.md` | Anything touching store scoping |
| `docs/eclat-schema.md` | Understanding the data model |
| `docs/legacy-schema.md` | Anything touching Gati/APRS-SJEP |
| `docs/GATI_DATA_CONTRACT.md` | Sync field mappings |
| `docs/DATA_PIPELINE.md` | How legacy data flows in |
| `docs/DEPLOYMENT.md` · `GO_LIVE.md` | Deploying |
| `docs/DESIGN_SYSTEM.md` | Frontend work — "Assay" design system, tokens, typography |
| `docs/CLIENT-CALL-2026-07.md` + `CLIENT-NOTES-*` | What the owner actually asked for. Authoritative on business rules |
| `docs/WHATSAPP-BOT.md` | The WhatsApp bot specifically |
| `docs/HANDOFF.md` | ⚠️ Last updated 2026-06-24 — **stale**, useful for history only |

---

## 14. A reasonable first week

1. Get it running locally (§4). Sign in as each seeded role and click through — the fastest way to understand the product.
2. Read `CLAUDE.md`, then `docs/PRODUCTION_READINESS.md`, then `docs/MODULES.md` for one module you'll work on.
3. Read `StoreScopeService` and one service that uses it (`reporting.service.ts` is a good example). That's the pattern you'll repeat everywhere.
4. Run the test suite so you know what green looks like before you change anything.
5. First task: the WhatsApp bot frontend (§11). Self-contained, the backend endpoints exist, and it touches auth, scoping, and the design system — a good tour of the codebase without much risk.
