# Eclat / CaratSense — Codebase Audit vs Build Spec

> Evidence-based audit run against the "Jewellery Business Platform — Build Spec, Verification & Fix Plan" (§8 prompt).
> Method: read controllers/services/schema/pages directly; ran `nest build` and `tsc --noEmit`. Every status carries a file/route as evidence.
> Date of run: 2026-06-24. **No features were added** — this is inventory only.

---

## STEP 0 — Stack discovery

| Question | Answer | Evidence |
|---|---|---|
| Languages | TypeScript (backend + frontend) | `backend/`, `frontend/` |
| Backend framework | **NestJS 11** + Prisma 6 | `backend/package.json`, `backend/src/app.module.ts` |
| Database | **PostgreSQL** (`eclat_dev`), Prisma ORM | `backend/prisma/schema.prisma`, `datasource db { provider="postgresql" }` |
| Web frontend | **Next.js 16 + React 19 + Tailwind v4**, shadcn/ui, react-query, zustand, ECharts | `frontend/package.json` |
| Mobile app | **❌ NOT BUILT** (spec wanted React Native/Expo) | no `mobile/` dir; web is responsive only |
| Shared backend | ✅ one REST API serves the web app | `frontend/src/lib/api.ts` → `NEXT_PUBLIC_API_URL` |
| How to run | BE: `cd backend && npm run start:dev` (port 4000). FE: `cd frontend && npm run dev` (port 3000). DB: Postgres + `npm run migrate:dev` + `npm run db:seed` | `package.json` scripts |

**Reconciliation with spec §2:** the target stack matches (Next.js + NestJS + Postgres + Redis-less). Divergences: **no mobile app**, **no Redis** (no queues/cache yet), **pgvector not installed** (embeddings modelled as `Float[]`).

---

## STEP 1 — Module coverage

Legend: ✅ Done · 🟡 Partial · ❌ Missing/Not built · ⛔ Out of scope (decided)

### 1. CRM & Lead Management
| Sub-feature | Status | Evidence |
|---|---|---|
| Omnichannel lead capture | 🟡 | `LeadSource` enum = walk_in/phone/whatsapp/website/instagram/referral; `POST /leads` tags source. **Manual entry** — no auto-ingest from website/WhatsApp inbound. |
| Central customer DB | ✅ | `model Party` (multi-role), `storeId` scoped — `schema.prisma:425` |
| Automated follow-ups | 🟡 | data only — no scheduler fires them (see Cross-cutting) |
| Remarks & reminders | ✅ data / 🟡 firing | `model LeadNote`, `model OccasionReminder` (`notified` flag never flipped by a job) |
| Store/salesperson view | ✅ | `LeadsService.list` uses `StoreScopeService.storeFilter` — `leads.service.ts:44` |
| Lead → order pipeline | 🟡 | `LeadStage` inquiry→quotation→order_placed + Kanban (`crm/page.tsx`). Stage is a flag; no hard Quote→Sale conversion link. |
| Occasion reminders to customer + staff | ❌ automation | model exists; nothing sends them |

### 2. Quotation & Pricing
| Sub-feature | Status | Evidence |
|---|---|---|
| Unified pricing (WhatsApp/web/store) | 🟡 | `MetalRate` + `QuoteLine` rate snapshot + `GoldRateService`. In-store ✅; WhatsApp 🟡 (dry-run); website channel ❌ |
| Central quote engine | ✅ | `quotes.service.ts`, `model Quote`/`QuoteLine` |
| Single quote across stores | ✅ | `model QuoteRedeemableStore` (quote at A, redeem at B) |
| One-click WhatsApp share | 🟡 | `POST /integrations/whatsapp/send`; code-complete, **dry-run until WHATSAPP_* keys set** |

### 3. Departmental Dashboards & Collaboration
| Sub-feature | Status | Evidence |
|---|---|---|
| Department/role views | ✅ | `dashboard.service.ts` role-scoped KPIs (`isBroad`), `dashboards/page.tsx` |
| Meetings/calendar/to-dos | 🟡 | to-dos ✅ (`model Task`, `GET/POST /dashboard/tasks`); meetings + calendar ❌ |
| Consolidated meeting summaries | ❌ | not built |
| Cross-dept hand-off w/ owner | 🟡 | `Task.assignee` exists; no dept-routing/ownership-transfer workflow |
| Overdue task escalation | ❌ | needs scheduler |
| Automated MIS reporting | ❌ | needs scheduler |

### 4. Finance & Fund Planning
| Sub-feature | Status | Evidence |
|---|---|---|
| Finance module | ✅ | `finance.controller.ts` (ledger/summary/budget/cashflow), `@Roles` SM+ |
| Per-store rentals & salaries | ✅ | `GET /finance/budget` + `/cashflow` |
| Collection tracking | ✅ | `model Payment` + `LedgerEntry` kind=AR |
| Budget vs actual variance | ✅ | `GET /finance/budget` |
| Cash-flow forecast (incl. new-store costs) | ✅ | `GET /finance/cashflow` (rule-based) |

### 5. Project & Expansion Pipeline
| Sub-feature | Status | Evidence |
|---|---|---|
| New store setup | ✅ | `model NewStoreProject`, `new-store.service.ts` |
| Task workflows | ✅ | `model NewStoreChecklistItem` per dept |
| Automated 3-month reports | ❌ | needs scheduler |
| 5-dept coordination | ✅ | `enum NewStoreDept` = it/inventory/interiors/hr/marketing |
| Dept config for new stores | ✅ | checklists keyed by `department` |
| Location-wise updates | 🟡 | project `city`/`regionId` |
| Weekly progress per dept | ❌ | no weekly snapshot/automation |
| Vendor/contractor assignment | ✅ | `model NewStoreVendor` |
| 30/60/90-day milestone alerts | 🟡 | `model NewStoreMilestone` (T-90/60/30 markers) exist; **alerts never fire** |

### 6. Catalogue & Product Management
| Sub-feature | Status | Evidence |
|---|---|---|
| Multi-store / custom orders | ✅ | `Product.storeId`, `model CustomOrder` |
| Unified product view | ✅ | `GET /products`, `catalogue/page.tsx` |
| Auto-cataloguing every unique product | 🟡 | sourced from legacy sync (`StyleMst`) + `POST /products`; "auto every unique" depends on sync running |
| Centralized sales recording | ✅ | `model Sale`/`SaleLine` |
| Real-time stock across stores | ✅ | `GET /stock`, `model StockItem` |
| AI image-based search | 🟡 | `ai-image-search.service.ts` (Claude vision + rule-based scoring), `POST /products/image-search`. Needs ANTHROPIC key + real images; pgvector not installed so similarity is attribute-rule-based, not embedding-ANN |

### 7. HRMS & Geo-Tagged Attendance
| Sub-feature | Status | Evidence |
|---|---|---|
| Geo-tagged attendance | 🟡 | `AttendanceRecord` lat/lng/`geoVerified` + haversine `distanceM` (`hrms.service.ts:34`). **Display computes fence**, but `markAttendance` doesn't capture lat/lng or set `geoVerified`; no mobile GPS capture |
| Unified store/branch location view | ✅ data / ❌ map UI | `Store.latitude/longitude/geofenceRadiusM`; no Google Maps view |
| Sales leaderboard (footfall→quotes→sales) | ✅ | `GET /hrms/leaderboard` |
| Commission auto-calc | 🟡 | `model Commission` + `GET /hrms/commission`; not recomputed by a job |
| Leave/roster/shift | 🟡 | leave ✅ (`LeaveRequest`, `PATCH /hrms/leave/:id`); roster/shift ❌ (shift is a hardcoded string) |
| CCTV analysis | ⛔ | dropped — `docs/DECISIONS.md` |

### 8. Customer Check-ins & Footfall
| Sub-feature | Status | Evidence |
|---|---|---|
| Client-attended tracking + salesperson timeline | ✅ | `model CheckIn` (repId, timeIn/out, purpose/outcome), `checkins/page.tsx` |
| Customer view-only access | ⛔ | OP-1 decided **internal-only**; no customer login role |

### 9. Inventory & Stock Management
| Sub-feature | Status | Evidence |
|---|---|---|
| Dead/aging stock | ✅ | `StockStatus` aging/dead_stock + `ageDays` |
| Identify non-moving stock | ✅ | status + ageDays filters |
| Stock rotation | 🟡 | `model StockMovement` + `transferred` status; no rotation suggestions |
| Melting of non-selling stock | 🟡 | `StockStatus.melted`; no guided melt workflow |
| Scrap management | 🟡 | folded into `melted`; no distinct scrap flow |
| Reorder alerts w/ suggested qty | ❌ | no reorder engine/scheduler |

### 10. Reporting & DSR
| Sub-feature | Status | Evidence |
|---|---|---|
| Walk-in/footfall/payment capture | ✅ | `CheckIn` + `PaymentMode` (cash/online/…) |
| Weekly & monthly reporting | 🟡 | `GET /reporting/dsr` is daily; weekly/monthly rollup not exposed |
| Timeline summaries | ✅ | `CustomOrder`/`CustomOrderEvent`, `timelines/page.tsx` |
| Per-store benchmarking | ✅ | `dashboard.service.charts` storeComparison |
| Fast/slow movers | ✅ | `GET /reporting/movers` |
| **Auto DSR via WhatsApp + email every evening** | ❌ | **no scheduler + no email transport.** WhatsApp send exists (manual/dry-run) only |

### 11. Ticketing & Issue Management
| Sub-feature | Status | Evidence |
|---|---|---|
| Raise from any store | ✅ | `POST /ticketing` |
| Auto-routing to dept | 🟡 | `TicketCategory` + assignee; no auto-assign-to-dept-head rule |
| Recurring-issue detection | 🟡 | `Ticket.patternTag` field; detection is manual |
| Return management across stores | ✅ | returns module |
| Refund/exchange/credit-note | ✅ | `ReturnRecord.settlement` (credit_note/refund/exchange) + status workflow |

### 12. Returns & Exchange Management
| Sub-feature | Status | Evidence |
|---|---|---|
| Photo intake (returns/changes/repairs/old gold) | ✅ | `enum ReturnType` + `model ReturnPhoto` + `StorageService` (local-disk, `/uploads`) |

### 13. Discount Management
| Sub-feature | Status | Evidence |
|---|---|---|
| Predefined discount codes | 🟡 | request/approval model, not literal "codes" — `model DiscountRequest` |
| Role-based control | ✅ | `model DiscountLimit` per role + `RolesGuard` |
| Cross-store | ✅ | storeId scoping |
| Margin-impact preview before approval | ✅ | `DiscountRequest.marginImpact` shown pre-decision |
| Usage analytics | 🟡 | data present; no analytics view |
| Per-customer discount history | 🟡 | `customerName` on request; not a dedicated history view |

### 14. Marketing Management
| Sub-feature | Status | Evidence |
|---|---|---|
| Agencies / in-house / backend teams | 🟡 | `MarketingCampaign.agency` + `MarketingAsset` + `GET /marketing/agency-tasks`; team mgmt is basic |
| Jewellery-marketing focus | ✅ | `CampaignType` bridal/festive/catalog/… |
| Management oversight | ✅ | `marketing/page.tsx`, `GET /marketing/campaigns` |

### 15. Loyalty & Gold Savings Scheme
| Sub-feature | Status | Evidence |
|---|---|---|
| Scheme enrollment | ✅ | `model SchemeMember`, `POST /loyalty/members` |
| Collection tracking | ✅ | `model SchemeInstallment` + `Payment` link |
| Maturity tracking | ✅ | `SchemeStatus.matured` + tenure/bonus |
| Default-risk flags | 🟡 | `SchemeStatus.defaulted` + `InstallmentStatus.missed`; auto-flagging needs a job |

---

## STEP 2 — Reality check

- **Builds:** `cd backend && npx nest build` → **exit 0**. `cd frontend && npx tsc --noEmit` → **exit 0**.
- **Migrations:** 3 applied — `20260617100657_init`, `20260623125937_new_store_region`, `20260623160453_dashboard_tasks` (`backend/prisma/migrations/`).
- **Tests:** e2e specs present — `app.e2e-spec.ts`, `integrations.e2e-spec.ts`, `sync.e2e-spec.ts` (`backend/test/`). (Earlier runs: 40/40 passing; re-run with `npm run test:e2e` against a test DB to re-confirm.)
- **Mock vs real data:** Frontend pages import from `@/lib/mock/*` for **types + label constants only**; actual data comes from `@/lib/queries/*` → live API (e.g. `crm/page.tsx`: "Leads come live + already role/store-scoped server-side"). Backend services are real Prisma queries (`leads.service.ts`, `dashboard.service.ts` aggregate from DB). **No hardcoded/fake data in the rendered flows.**
- **Hardcoded leftovers (cosmetic):** HRMS `role: 'Sales Executive'` and `shift: 'Morning · 10:00–19:00'` are literals in `hrms.service.ts`.

---

## STEP 3 — Integrations: live vs placeholder

| Integration | Status | Evidence |
|---|---|---|
| WhatsApp Business | 🟡 code-complete, **dry-run until keys** | `whatsapp.service.ts` (`enabled` = token+phoneId; logs no-op otherwise), webhooks signature-verified |
| Email (SES/SendGrid) | ❌ **not implemented** | no nodemailer/sendgrid/ses dependency; no mail service |
| Payments (Razorpay) | 🟡 code-complete, dry-run until keys | `razorpay.service.ts`, payment-link + signed webhook |
| Maps / geo-tagging | 🟡 | schema + haversine present; no Google Maps API / map UI; capture write-path incomplete |
| AI image search | 🟡 | `ai-image-search.service.ts` (Claude vision + rule-based); needs ANTHROPIC key + images + pgvector |
| CCTV analytics | ⛔ dropped | `docs/DECISIONS.md` |
| Push notifications | ❌ | none (no mobile app) |
| Legacy SJEP sync | 🟡 built, not yet live | `sync_sjep.py` + `POST /sync/*` (watermark upserts); awaits on-site SQL Server connection |
| Google sign-in | 🟡 code-complete, dry-run until key | `auth.service.loginWithGoogle` (verifies via tokeninfo; matches existing user only) |

---

## STEP 4 — Access & flows

- **RBAC enforced (not just defined):** global `JwtAuthGuard` + `RolesGuard` via `APP_GUARD` (`app.module.ts:61`). `@Roles(...)` on sensitive routes (finance, sync=head_office, product/stock writes, new-store=area+). Store isolation via `StoreScopeService` on every list/get. OP-5 self-scope for salesperson in HRMS leaderboard/commission. **Verified in code.**
- **Roles present:** salesperson, store_manager, area_manager, head_office (`enum Role`). **Customer view-only role = not implemented** (OP-1: internal-only). "Department head" is not a distinct role — modelled via store/role + tasks.
- **Lead → Quote → Order → DSR:** Lead ✅ → Quote ✅ (links `leadId`) → **Order: partial** (no one-click "convert quote to sale/order"; Sale/CustomOrder created independently) → DSR ✅ reads from `Sale`. **Gap: the quote→order conversion step.**
- **Return → Refund/Exchange/Credit-note:** ✅ end-to-end via `ReturnRecord.status` + `settlement`.

---

## Blocking issues (block production go-live / break a spec acceptance test)

1. **No scheduled-job layer at all** (no `ScheduleModule`/cron). This breaks the acceptance tests for: evening auto-DSR, occasion reminders, overdue escalation, MIS, 3-month/weekly reports, 30/60/90 alerts, reorder alerts, default-risk flags. *Single highest-impact gap.*
2. **No email transport** — auto-DSR "via email", and any email notification, cannot work.
3. **Quote → Order conversion** is not a wired action — the core sales funnel has a manual break.
4. **No mobile app** — geo-attendance, field check-in, photo intake were specced for mobile; only responsive web exists, and the attendance write-path doesn't capture GPS.

(Nothing breaks the running app — it builds and serves. These block *full* go-live, not boot.)

## Prioritized pending work

**Must-fix (before launch)**
- Add `@nestjs/schedule` + a jobs module: evening DSR push, occasion reminders, milestone/reorder alerts, default-risk sweep, MIS.
- Add an email provider (SES or SendGrid) behind env keys; wire DSR + reminders to it.
- Wire **Quote → Order** conversion (button + endpoint creating a `Sale`/`CustomOrder` from a quote).
- Complete geo-attendance capture (store lat/lng + `geoVerified` on `markAttendance`).
- Provision real credentials: WHATSAPP_*, RAZORPAY_*, ANTHROPIC_API_KEY, GOOGLE_CLIENT_ID; connect on-site SJEP sync.

**Should-fix**
- Reorder-alert engine with suggested qty; weekly/monthly DSR rollups.
- Ticket auto-routing rule + recurring-issue auto-tag; discount usage analytics + per-customer history view.
- Roster/shift management (replace hardcoded shift); Maps view for store/attendance.
- Meeting/calendar + meeting summaries (Module 3).

**Nice-to-have (post-launch)**
- pgvector + real CLIP-style embeddings for AI image search (upgrade from rule-based).
- Redis for queues/cache; audit-log table for pricing/discount/refund changes.
- Native mobile app (React Native/Expo) for field staff + offline sync.

## One-line verdict

**Demo-workable now, and production-workable for in-store web operations** — it builds, RBAC is enforced, and all 15 module domains have real DB-backed data + UI; **but not production-complete** until the scheduled-automation layer, email, quote→order conversion, and live integration credentials are in place.
