# Follow-up meeting, 9 October 2026 — mapped action plan

Every item below was mapped against the code before planning. Buckets:
**[READY]** implement after this verification · **[EXISTS]** already built, only
expose/adjust · **[BLOCKED]** awaiting client input or a decision.
Delivery rule unchanged: PR only, no merge without the client's go-ahead.

---

## 1. Quick Actions — add Mark Attendance and Customer Data & Imports **[READY]**

**Verified:** the bar has exactly three actions, as the client said —
"Log walk-in", "New lead", "Quick quote" (`frontend/src/components/layout/sidebar.tsx:343-370`,
`QuickActionMenu` at :334). Wiring pattern: a zustand hand-off store
(`store/use-quick-action.ts`, `QuickActionKind = "lead" | "checkin"`) + `router.push`;
the target page owns its dialog. Gating is "slug visible in the user's sidebar"
(role + industry pack + per-person AccessMap) — never offer what a route guard refuses.

**Changes.**
- **Mark Attendance** → two real flows exist: self-punch `/check-in`
  (open to every signed-in role, but NOT a nav slug — `navigation.ts:955-961`) and
  manager marking others at `/hrms` ("Mark Attendance" header action,
  `hrms/page.tsx:99-104`). Plan: one action labelled "Mark attendance", gated on the
  `hrms` slug (visible to all ladder roles), routing manager+ → `/hrms` with the
  dialog requested via a new `QuickActionKind "attendance"`, everyone else → `/check-in`.
- **Customer Data & Imports** → the flow lives at `/data` ("Data & Imports",
  import wizard tab; customers is a supported import entity —
  `integration/import/field-dictionary.ts:14`). No import UI exists inside
  CRM/customers, so the action deep-links `/data` opened on the Import tab via a new
  `QuickActionKind "import"` (the tab is local state, `data/page.tsx:32`).
  Slug `data` is manager+ only — the action self-hides for salespeople, which
  matches the backend guard (`import.controller.ts:92`).

Result: five actions for a manager, four for roles without `/data`. Effort: small.

## 2. Gati sync — customers, sales, billing **[EXISTS — mostly]** / payments **[BLOCKED]**

**Verified provider:** **Gati SJE Plus (APRS-SJEP)** — the client's on-premise
jewellery ERP on SQL Server. Integration = on-site Python agent
(`synceclatcaratsense/`, Task Scheduler, **every 15 min**), read-only SQL login,
pushes to `POST /sync/*`. Source of truth: `GATI_DB_SYNC.md`. **Nothing ever
writes back to Gati — by design** (DENY-write login).

**Already synchronised today** (correcting the meeting notes' premise):
customers (`PartyMst` → `Party`, 909 on first backfill), **historical sales**
(`JewelTrans`/`JewelTransInward` → `Sale`/`SaleLine`, 880 bills / 6,321 lines),
ledger day-book, stock + movements, designs/styles, images, manufacturing orders,
bags, metal rates, stores, staff — plus a full raw mirror of every APRSSJEP table
in `LegacyRow`, so new mappings never need an agent change.

**Genuinely missing:**
- **Customer receipts with payment mode** (UPI/card/cash): `VoucherEntry` is
  deliberately unmapped — `docs/GATI_DATA_CONTRACT.md` §8 marks it
  *BLOCKED / CLIENT INPUT REQUIRED*. This is the real gap behind "billing sync".
- Invoice *documents* (no `Invoice` model; `Sale.invoiceUrl` is a manually
  uploaded photo; GST breakup per bill unmapped).
- Per-piece karat, hallmark/HSN values, manufacturing stage map, CustomOrder↔Gati
  order linkage.

**Decisions to put to the client (do not assume):** sync direction (one-way
Gati→CaratSense today; two-way would break the read-only design and needs an
explicit decision), frequency (15 min — confirm acceptable), duplicate handling
(keyed on Gati's own ids — already dedup-safe), conflicting values (field-ownership
registry already marks Gati source-of-truth-protected — confirm that stands).

## 3. Rename to Nibhana **[READY mechanically — one scope question first]**

**The question that decides everything:** Nibhana replaces *which* name?
- **The tenant's business name** ("Eclat Diamonds") → near-zero code: it is
  DB-driven (`Organisation.settings.branding.displayName`, `lib/branding.ts:13`).
  One settings change + the hardcoded legal line in the quote PDF
  (`quote-pdf.ts:563` "Eclat Diamonds offers 80%…") made data-driven.
- **The product name** ("CaratOS"/"CaratSense") → the audited scope below.

**Audited product-rename scope (code-verified):** no single brand constant exists.
- ~19 frontend files with user-visible "CaratOS" (logo lockup `brand/logo.tsx`
  including the split `Carat`/`OS` spans, sidebar footer, login page incl. the ©
  line, `layout.tsx` titles, **PWA manifest**, install dialog, welcome tour, body copy).
- 18 backend outbound-string sites (quote/DSR PDF+XLSX creators, report email
  subjects/bodies, WhatsApp OTP "Your Eclat sign-in code…", bot replies, digest
  copy, provenance sentences).
- **Lockstep trap:** `auth.service.ts:426` message is string-matched by
  `login/page.tsx:395` — change together.
- **Do-NOT-rename list** (breaks things): localStorage keys `eclat.*`, wire headers
  `x-caratos-*`, webhook key `caratosMeta`, persisted enum `CARATOS_OWNED`, crypto
  AAD/storage magic strings, seeded ids `org_eclat`, R2 bucket, package names,
  repo/infra names.
- Plan: introduce one `BRAND` constant each side, swap the 19+18 sites onto it,
  new wordmark/logo assets + PWA icons (**client must supply the Nibhana logo**).

## 4. Customer deletion and tagging — tags **[READY]** / delete **[BLOCKED — decision]**

**Tags (verified absent for customers):** `LeadTag`/`LeadTagAssignment` tag
**leads only** (no `partyId` anywhere in the join). Plan: `PartyTagAssignment`
reusing the same `LeadTag` vocabulary (one tag list, two targets), endpoints
`GET/PUT /parties/:id/tags` (salesperson applies, manager manages — mirrors
`lead-tags.controller.ts` gating), tag chips + filter on `customers/page.tsx`
and `customers/[id]`, and a `party.tag` field in the segment DSL so campaigns can
target by customer tag. Straightforward.

**Delete (verified deliberately refused today):** `/parties` has **no delete and
no edit** — archive/restore only (`parties.controller.ts:70-90`), and the schema
comment at `Party.archivedAt` records the refusal of a hard delete. A raw delete
is blocked by 15+ `Restrict` FKs (sales, payments, ledger, quotes, conversations,
loyalty…); the only real `party.delete` in the codebase is inside the reviewed
duplicate-merge (head-office, plan-hash-guarded). **Recommendation to client:**
archive *is* delete for customers with history (hide from lists, audited,
reversible); offer a true head-office hard-delete only for parties with **zero
financial records** (created-by-mistake rows), refusing otherwise with the counts
shown. Needs the client's yes before building; the archive UX can meanwhile be
surfaced more prominently (it exists but is easy to miss).

## 5. Walk-in Log to the top of Check-in & Footfall **[READY — trivial]**

**Verified:** `/checkins` renders, in order: header → export → stat tiles →
live-in-store → two charts → **Walk-in log last** (`checkins/page.tsx:185-265`;
the log is `CheckInLog`, `checkin-tables.tsx:214`, titled "Walk-in log"). No tabs,
no state coupling — a pure JSX move of `<CheckInLog>` to directly under the header,
with its own loading skeleton pulled out of the shared ternary.

## 6. Reorder **[BLOCKED — clarification]**

**Verified: no reorder feature exists anywhere**, and the Inventory tab named
"Reorder" is an empty reorder-*points* placeholder (name collision to avoid).
Closest building blocks: quotes already reference designs
(`QuoteLine.productId/styleNumber` + style lookup `GET /materials/styles`), and
`POST /quotes/:id/convert-to-order` exists; there is **no duplicate-quote
endpoint**, and custom orders (`CO-`) take free-text customer/item with **no
partyId or productId written**. **Hard blocker found:** the customer's purchase
history never exposes *what* was bought — `customer360` selects sale headers only,
and `GET /sales/:id` drops `productId`/`stockItemId`/sku from lines. Any
customer-side "Reorder" button first needs those surfaced.

**Ask the client:** (a) reorder = same **design** again for a customer, duplicate
a past **quote**, re-raise a past **custom order**, or store **stock**
replenishment? (b) should it create a quote at today's gold rate or carry the
original price? (c) does "existing piece" mean a design (style number) or the
exact sold piece's specs? (d) does it need head-office approval like other
order flows?

## 7. Date-specific weekly offs in Roster & Pay **[READY — small model change]**

**Verified model:** weekly off = recurring weekday only, two layers —
`Store.weekOffDay` (branch default) and `StaffWeekOff` (per-person override,
`dayOfWeek 0-6`, max 3, no date columns). Resolution duplicated in two readers:
`payroll.service.ts:235-247 offDaysFor` and `attendance-ops.service.ts:330-335`.
UI = Sun–Sat checkbox grid on Roster & Pay. A per-date *workaround* exists (a
manager can set `status: week_off` on any register date), but it is one date at a
time and not a roster.

**Plan:** add a per-date assignment (`StaffDayOff { userId, storeId?, date, createdById }`,
`@@unique([userId, date])` — precedent: `ShiftAssignment` already carries
`effectiveFrom/To @db.Date`). Date rows **win over** the weekday pattern for their
week; the weekday grid stays as the fallback pattern. Consolidate the two
`offDaysFor` copies into ONE date-aware helper consumed by payroll, attendance-ops
and day-close (this also discharges half of item 8). UI: Roster & Pay gains a
month view grouped by weeks — each employee × week gets a date picker limited to
that week; month must be payroll-open (existing `assertMonthOpen` rule). Weekly
offs stay a distinct attendance status (`week_off`) separate from leave types;
`week_off_leave` (the "no fixed off day" leave workaround) remains untouched.

## 8. Roster & Pay vs HRMS overlap **[documented — consolidation proposal]**

Verified duplication: weekly-off configured on **both** screens through two
different endpoints/models; the off-day rule implemented twice; **three** staff
lists (`/users`, `/hrms/employees`, payroll's inline query); leave surfaced in
three places with allocation editable via two endpoints; the payroll month-**lock**
administered in HRMS but enforced in Roster & Pay; compensation set under HRMS
Employees while the payslips it feeds live in Roster & Pay; plus a dead,
contradictory `roster-tab.tsx` imported nowhere.

**Proposed homes (for client sign-off before anything moves):**
- **Roster & Pay** owns *scheduling and money*: weekly offs (incl. item 7),
  date-specific offs, compensation, payroll locks, payslips.
- **HRMS & Attendance** owns *capture and people*: punches, register, approvals,
  leave, employees, shifts/holidays.
- Mechanical first steps safe to do with item 7: single shared `offDaysFor`,
  delete `roster-tab.tsx`, move the lock card onto the screen it governs.

## 9. Scheduled reports via the internal WhatsApp number **[READY]**

**Verified:** `purpose:'internal'` is read in exactly two places — the **evening
DSR digest already sends from the internal staff line**
(`dsr-digest.service.ts:224-237 internalRoute()`, recipients = head-office phone
list incl. Pratham & Ayushi in org settings), and inbound classification. The
"Scheduled Reports" page (lead spreadsheets, `ScheduledReport` model) is
**email-only**: recipients are email-validated (`scheduled-reports.service.ts:59`),
delivery is `EmailService` with `dry_run` when SMTP is absent — no WhatsApp path
exists. The morning staff digest routes by **branch** number, not internal —
confirmed: recipients differ per report type, exactly as the notes warned.

**Plan:** lift `internalRoute()` into a shared helper beside `chooseAsset`
(`whatsapp-credentials.service.ts`); add a WhatsApp delivery branch to
`ScheduledReportsService.deliver()` — phone-shaped recipients alongside emails,
document send (XLSX) like the existing `POST /reporting/daily/sheet/send`, runs
recorded with a `whatsappStatus` mirroring `emailStatus`. Keep each report's own
recipient list; nothing inherits the DSR's. Caveat to carry: the 24-hour customer-
care window note already documented on the digest applies to free-text/document
sends on the staff line.

## 10. Sidebar order **[DONE — document received 9 Oct and applied]**

"CaratOS SideBar.docx" applied: groups renamed to the client's names
(Today → **Command Centre**, People → **Customer Interactions**, Stock →
**Stock Management**, Team → **HR & Teams**), "Selling" and "After the sale"
folded into **Showroom** (check-in → catalogue → quotation → production →
discounts → returns → reporting → payments → loyalty), Data & Imports moved to
Stock Management, Message Templates to Customer Interactions, Audit Log to
HR & Teams, Team/People & Access to Setup. Explicit hides honoured: Points
Programme and Getting Started. Labels per the doc's "rename as you find fit":
Calls Due, Feedback Requests, Discount Requests, Loyalty & Referrals,
Finance & Funding, App Integrations. Implemented as a `rank` field per item
(`navigation.ts`), so future reorders are data edits.

**Deliberately NOT applied — the doc's role annotations** ("Admin only" on
Command Centre, "Admin & Sales Team only" on Showroom, etc.): taken literally
they would strip store managers of their dashboards and reporting. "Admin" in
the client's vocabulary needs defining against our role ladder before any
visibility changes. Flagged for the next call.

**New feature asks found inside the document (parked, not sidebar work):**
"HR Apply Requests" incl. **Petty Expense** (new capability), "Shifts and
Schedule" as a standalone page with all-teams view access, "Reports (HRMS) and
PaySlips" as one merged page (matches item 8's consolidation), and an entire
**Marketing** group (events, payment requests, invoice/image uploads, social
calendar, ads performance) marked "Setup Later" — that is Module 16 scope.

## 11. Manual catalogue creation **[EXISTS — needs rounding out]**

**Verified: already built end-to-end.** `POST /products` (manager+,
`products.controller.ts:167-172`) + the "Add Product" dialog on `/catalogue`
(`catalogue/page.tsx:451+`), image upload routes (single + 10-at-once gallery),
R2 storage, and the sync cannot delete manual rows (reconcile only touches
`legacyId` rows). Four sources coexist by design: Gati, website, file import, manual.

**Gaps to close:** no **edit** (`PATCH`) or **delete** endpoint at all — a manual
product's name/price/weight is immutable once created; the dialog omits fields the
DTO already accepts (description, carat weight, availability/lead time) and the
DTO itself lacks `styleNumber` (the design code quotes key off); `storeId` is
forced, while every Gati design is company-wide (`storeId null`) — manual entries
should be allowed company-wide too; multi-image at create isn't wired. Final form
fields and image requirements await the client's sample entry.

---

## Priority order

**Build now (clear + verified):**
1. Walk-in Log to top (#5) — minutes.
2. Quick Actions ×2 (#1) — small.
3. Customer tags (#4a) — small/medium.
4. Catalogue rounding-out: edit/delete + missing fields + company-wide (#11) — medium.
5. Date-specific weekly offs (#7) + the shared `offDaysFor` + dead-file removal (#8 mechanical slice) — medium.
6. Scheduled reports over internal WhatsApp (#9) — medium.

**Needs one client answer, then build:**
7. Nibhana rename (#3) — *which* name, + logo assets.
8. Customer delete semantics (#4b) — archive-as-delete vs guarded hard delete.
9. Gati payments sync (#2) — the VoucherEntry mapping sign-off the data contract already demands.

**Fully blocked on client input:** sidebar order document (#10), reorder
workflow definition (#6), catalogue sample entry/fields (#11 final form),
invoice & payslip format samples (for the PDF work implied by #2/#3),
HR consolidation sign-off (#8 beyond the mechanical slice).

## Client inputs required (consolidated)

1. Sales-invoice sample, 2. payslip sample, 3. catalogue sample entry + image
requirements, 4. sidebar-order document, 5. reorder workflow answers (item 6),
6. **Nibhana scope** — product name or shop name — plus the Nibhana logo files,
7. customer-delete decision (item 4), 8. Gati: two-way sync yes/no + VoucherEntry
payment-mode mapping confirmation.
