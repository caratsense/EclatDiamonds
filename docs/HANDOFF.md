# Eclat / CaratSense — Session Handoff (START HERE)

> **Current-state correction — 2026-09-07:** The June narrative below is historical. Eclat has pivoted to multi-tenant **CaratOS**: Organisation tenancy, CRM spine/inbox, imports, integrations, qualification, attribution, job queue and expanded product UI are present as uncommitted work. Read `CARATOS_ARCHITECTURE.md`, `OPERATIONS.md`, root `CARATOS_STEP1_AUDIT.md` and `CARATOS_STEP2_REPORT.md` before relying on the older status.
>
> **Latest enhancement:** competitor CRM inputs were reviewed in `COMPETITOR-CRM-ENHANCEMENT-REVIEW.md`. Ad-set routing and per-rule AI/human control are implemented **and now connected to inbound CTWA traffic** (see the 2026-09-07 section below). Live Meta credentials, app review and real-payload verification remain outstanding.
> The complete new-feature and external-connection checklist is in `NEW-FEATURES-AND-INTEGRATION-SETUP.md`.
>
> **New machine / new Claude session? Read this file first, then `CLAUDE.md`.**
> This captures the full project state so work can continue exactly where it stopped.
> **Last updated: 2026-09-15.**

## 2026-09-15 — CURRENT STATE (read this first)

Feature coding for the parity programme is closed. What remains is credentials,
client inputs, staging UAT and a deploy decision — not code. The 2026-09-10 section
below is history: its "Blocks 3–10 of the parity brief are untouched" line is no
longer true, and neither is PR #4's earlier description of Blocks 1–15 as complete
before the acceptance gaps listed here were closed.

### Where the code is

| | |
|---|---|
| Branch | `phase-6-meta-integrations`, pushed |
| Pull request | https://github.com/caratsense/EclatDiamonds/pull/4 — open, **not merged** |
| `main` / production | `91a5d79`, deployed 2026-09-11. Nothing from this branch is on staging or production |
| Migrations not yet on production | 21, all additive (`20260912120000` … `20260915160000`) |

### Closed on 2026-09-15

| Gap | Screen | API |
|---|---|---|
| Lead board tag filter + search, carried into the export | `/crm?tags=…&q=…` | `GET /leads?tagIds=&q=`, export same filter |
| Follow-up reminder at a chosen time | check-in dialog, lead timeline, `/reminders` | `GET/PUT /crm/follow-up-reminders/settings` |
| Automatic feedback ask after a visit (default 7 days) | `/feedback` (after-visit card) | `GET/PATCH /feedback/settings` |
| Staff digest through the omnichannel outbox | `/settings/staff-digest` | `/staff-digest` |
| Quote discount cap + approval bound to the revision, detailed PDF | quote builder | `PATCH /quotes/:id`, `GET /quotes/:id/pdf`, `POST /quotes/:id/send-pdf`, `GET /quotes/:id/approval`, `POST /discounts/limits` |
| Stock classes and dead-stock views | `/inventory/dead-stock` | `/stock/dead`, `/stock/dead/policy`, `/stock/dead/export.xlsx`, `/stock/dead/classification/*` |
| Month-end payslip drafts and run log | `/hrms/payroll` | `/hrms/payroll/payslips`, `/hrms/payroll/week-offs`, `/hrms/payroll/runs` |
| Loyalty website announcements with a delivery log | `/loyalty/programme` | `/loyalty/programme/webhooks`, `…/webhooks/:id/retry` |
| Management KPIs uncapped (approval turnaround over every decision) | `/management` | `GET /management/kpis` |
| Multi-store DSR on every figure, with its basis | `/reporting` | `GET /reporting/dsr` |
| Head-office catalogue photo ZIP export | `/data/images` | `/catalogue-exports` |
| Strict salesperson scope | every CRM/sales screen | enforced in services — see below |
| Storeperson role | `/inventory`, `/catalogue`, `/hrms` | `@Permit` permissions in `auth/permissions.ts` |
| Store-scoped self-signup, atomic approval, Login ID template | `/login`, `/settings/team` | `POST /auth/signup`, `POST /auth/signup/preview`, `POST /users/:id/approve`, `POST /users/:id/reject`, `GET/PUT /users/signup-policy` |
| Attendance with no or imprecise GPS fix | `/check-in` | `POST /hrms/attendance` (`accuracyM`) |
| Messaging routes and integrations | `/settings/messaging-routes`, `/settings/integrations` | `/messaging-routes`, `/integrations` |

Also fixed on the way: the job queue claimed jobs on the database session's clock
rather than UTC; a hand-off accepted another tenant's user as assignee; manual bills
never recorded who rang them up; payments accepted a customer or bill id from
another tenant.

### Roles

- **Salesperson** — their own leads, assigned conversations, visits they attended,
  quotes assigned to them, their tasks, bills and returns, and customers reached
  through those. A record id typed into a URL is refused like one missing from the
  list. No management surfaces. Cannot reassign a lead.
- **Storeperson** — not on the ladder; admitted only where a route names a
  permission it holds: catalogue, inventory at its branch, its own attendance,
  leave and payslips. No customers, money, team or settings.
- **Store manager / head office** — unchanged: the branch, or every branch.

### Production configuration after a deploy (none of it is applied)

- Éclat's salesperson quote cap: `POST /discounts/limits {"role":"salesperson","maxPercent":5}` (head office).
- Éclat's 90-day dead stock: `PUT /stock/dead/policy {"thresholdDays":90}` (the seed sets it locally).
- `PRIVATE_UPLOAD_DIR` on a mounted volume (quote PDFs); `PUBLIC_APP_URL` for feedback links.
- After-visit feedback: turn it on in `/feedback` and approve its WhatsApp template.
- Reminder defaults in `/reminders`; optional Login ID template in `/settings/team`.
- Approval emails stay dry runs until `SMTP_*` is set.

### Verification (2026-09-15)

- **Clean worktree at the pushed HEAD:** Prisma validate, both typechecks,
  lints and builds, frontend unit tests and the full isolated e2e suite. The
  exact totals are in PR #4's description.
- **Browser matrix, `backend/scripts/browser-verify.mjs`:** 778 of 778 against a
  production build and a local API. Jewellery, healthcare and textile × salesperson,
  storeperson, store manager and head office × 1440×900, 420×900 and 390×844. That
  is 705 route renders, 64 screens outside the role opened by URL and refused, and
  9 checks that the CRM board shows each role exactly the leads it may see. No
  jewellery word reaches the other two industries.
  Two harness defects were fixed first. The vocabulary patterns had held backspace
  bytes and matched nothing, and the seeded tenants had no industry pack. Runs
  before 2026-09-15 did not really test vocabulary.
- **Migration rehearsal, `backend/scripts/migration-rehearsal.mjs`:** production's
  87 migrations, then rows including a customer thread, a quote, a follow-up, a
  feedback ask and a salesperson, then this branch's 21. Existing rows keep safe
  defaults. The remaining schema drift comes from migrations already on
  production: an AuditLog FK, three indexes, an ImportBatch default and one index
  name.
- **Negative controls, each an e2e test:**
  - cross-tenant tag filter
  - archived STOP contact at every send door
  - digest only through the outbox
  - duplicate feedback sweep
  - quote over cap, edited-after-approval and unauthorised PDF
  - storeperson and salesperson scope
  - cross-store approval, pending login and concurrent Login ID
  - duplicate payslip run
  - loyalty retry and replay
  - over 1,000 approvals in the KPI
  - wrong-branch sender
  - cross-tenant catalogue ZIP

### External, and only external

Meta Business verification and App Review · real Meta Page/Form/Ad Account/Instagram/WABA
assets · the client's eight-number-to-branch mapping · approved WhatsApp templates ·
live signed webhook verification · AI provider credentials and billing · a telephony
account · SMTP and a verified sending domain · Google Business Profile approval · a
live object-storage endpoint · Ayushi's Gati workbook and images · the client website
consuming the loyalty API · statutory payroll and tax policy · staging and production
deployment authorisation.

## 2026-09-10 — STATE AT THAT DATE (history)

Everything described below is now **committed and pushed**, on branch
`phase-6-meta-integrations`, and there is a **staging environment** to test it against.

### Where the code is

| | |
|---|---|
| Branch | `phase-6-meta-integrations` (pushed) |
| Pull request | https://github.com/caratsense/EclatDiamonds/pull/3 — open, **not merged** |
| `main` | still `9589ac5` (2026-08-19), untouched |
| Commits | `783e8f5` platform + integrations · `102e5ad` docs/screenshots · `ba52892` legacy-send + template identity · `ba843c4` QR secret, job alerts, allowlist · `86f6223` frontend lint · `4a4502f` staging · `4e6508a` handoff · `7ddc00b` QR screens · `88b5223` lead-path consistency |

The older "still uncommitted, HEAD is 9589ac5" note in the 2026-09-09 section below is
**no longer true** — it described the state before these commits.

### Competitor parity — audited, not finished

The competitor is **Zithara.ai** (seed-stage, Hyderabad). The circulated meeting notes
name it "Satara AI", which is a mis-hearing; the product on screen throughout the
40:24 recording is `app.zithara.com`. Treat anything else in those notes that was
*heard* rather than *seen* with the same caution — the pricing was separately confirmed
against the transcript and is correct.

**[docs/handovers/COMPETITOR-PARITY-STATUS.docx](handovers/COMPETITOR-PARITY-STATUS.docx)
is the audit**: 38 capabilities, each classified BUILT / FIXTURE / LIVE / PARTIAL /
MISSING / BLOCKED with the file that proves it. Read it before starting parity work —
it exists so the programme is sequenced against evidence rather than a feature list.
Current split: 19 built, 4 fixture-only, 2 live, 3 partial, 9 missing, 1 externally
blocked.

Two items moved to BUILT on 2026-09-10 in `88b5223`:

- A Meta lead whose routing rule chose a store but named no assignee now joins the
  branch's fair queue, like every other door.
- An ad click that matched no rule, and was therefore routed by hand later, now opens
  its lead — exactly once across both paths, with the measured attribution touch
  **relinked** rather than re-recorded (re-recording would count the click twice in
  ROAS, because the dedupe key embeds the subject).

### Parity work done 2026-09-10 (commits `f7ae487`, `5d28b9b`, `cc4295c`)

Four capabilities moved from MISSING to BUILT. Split is now 23 built, 4 fixture-only,
2 live, 3 partial, 5 missing, 1 externally blocked.

**Lead capture is closed.** Three new doors, all routed through a new
`LeadIntakeService` so one pipeline (identity → branch → follow-ups → activity → audit →
fair queue) applies whichever way a customer arrives:

- **Website form** — `LeadForm` table with an unguessable public key; the public
  endpoint resolves the tenant *from the key*, never from the body. Screens at
  `/crm/lead-forms` and `/enquiry/[publicKey]`.
- **Convert to lead** — organic WhatsApp still opens nothing on its own; a person
  decides, and converting is also when an anonymous thread legitimately gains an
  identity. Idempotent per conversation.
- **Import → leads** — a separate command per batch, not a checkbox in the wizard. Only
  rows the batch *created*. New `LeadSource.imported`, because the file never said how
  those people found the business.

**AI auto-reply exists and is off by default.** `ConversationAiGate.maybeAutoSend`
delivers via `OmnichannelService.queueAiReply`, which promotes the existing draft in
place rather than composing a second message, and does **not** set `handling: 'human'`
(doing so would make auto-reply fire once per conversation and then go quiet forever).
Consent, opt-out, the 24-hour window and templates are the same evaluation a person's
message gets. Confidence bar for sending is 0.85 against 0.55 for a draft. Daily cap and
a circuit breaker live in tenant settings.

`CrmModule` and `OmnichannelModule` are now a declared `forwardRef` pair — a real
two-way edge, documented in `crm.module.ts`.

### Still open, and why

- **Not live-verified.** The staging deploy and local DB setup were both refused by the
  session's permission classifier, so none of the above has run against staging. The
  backend is proven through 1033 e2e tests over real HTTP; the two new frontend pages
  are typechecked, linted and built but never browser-driven.
- **Blocks 3–10 of the parity brief are untouched**: campaign orchestration, extra
  channel adapters, feedback/reviews, in-store parity, loyalty refactor, connector
  completion, the universal UX audit and most admin screens.
- **CTWA leads still get no +7d/+30d follow-ups** while every other door does. Changing
  that affects every existing CTWA lead and is a product decision, not a bug fix.
- **QR capture still carries its own copy** of the intake sequence rather than calling
  `LeadIntakeService`. Folding it in needs round-robin lifted into its own service
  first; a `forwardRef` there would be papering over it.

### Staging

| | |
|---|---|
| Railway project | Eclat Diamonds (`2dd7e4a9-3ef7-48fd-8f69-d94caaa6448d`) |
| Environment | `staging` (`72bdfa56-71e1-4ee3-8a4a-10d0f5e00ea0`), own Postgres |
| Backend | https://backend-staging-e5cd.up.railway.app |
| Vercel preview | `eclat-diamonds-citvytt6r-carat-sense-s-projects.vercel.app` — **behind Vercel Authentication**, needs a team login or a share link |
| Login | `staging.admin@caratsense.in`, created by `backend/scripts/staging-bootstrap.mjs` |

Staging has its own database with **0 customers, 0 leads, 0 messages**. The staging
account returns 401 against production, which is the check that proves the two are
separate; re-run it before trusting any staging result.

`MESSAGING_RECIPIENT_ALLOWLIST` currently holds a placeholder that matches nobody, so
**staging can message no one** until a real test number is added. That is deliberate:
the allowlist reads an empty or unmatched value as "nobody", never "everybody".

Production was not deployed to and no production variable was changed. Rollback
reference for production is deployment `c76be0e2-2910-4ecd-a7bc-fd659ba4c9fe`.

### Four defects closed today

- **P1** — `POST /integrations/whatsapp/send` bypassed consent, opt-out, the 24-hour
  window, template approval, the outbox and the audit trail. It now queues through the
  omnichannel policy. **Contract change:** it reports `queued`, not a provider result.
- **P2** — a template asset was keyed by name alone, so an approved `en_US` verdict
  could authorise an unreviewed `hi_IN` send. Identity is now `name:language`
  (migration `20260910090000`, additive, never guesses a missing language).
- **P2** — `CRM_QR_SECRET` no longer falls back to `JWT_SECRET`; production fails closed.
- **P2** — dead jobs now page somebody (30-minute sweep, deduplicated per tenant,
  counts only — no customer data in the alert).

Plus all 26 React 19 lint errors, with no `eslint-disable` added.

### Read next

- `docs/META-STAGING-TEST-CHECKLIST.md` — the operator sheet for the first live test:
  both callback URLs, what to allowlist, what each screen should show, what to capture
  when something fails, and how to prove nothing replies after STOP.
- `docs/INTEGRATION-OPERATIONS-RUNBOOK.md` — running the connected accounts.
- `docs/screenshots/staging/` — the nine screens against the real staging backend,
  desktop and phone.

### Still true, and the thing to remember

**No live provider has ever answered.** Everything is proven against fixtures and a real
PostgreSQL. The Meta app secret, WhatsApp access token, Phone Number ID, WABA ID, Page
ID, Lead Form ID and Ad Account ID are all still outstanding, and until the app secrets
exist the signed webhooks refuse every payload — which is correct, and is what the 403s
in the verification log show.

## 2026-09-09 — CURRENT STATE (read this first)

Phase 6 closed the remaining integration honesty gaps (INT-01 to INT-11) and built the
nine connection-administration screens. (This was written while the work was still
uncommitted — see the 2026-09-10 section above for where it actually lives now.)

Start here:

- `docs/INTEGRATION-OPERATIONS-RUNBOOK.md` — how to run the connected accounts:
  environment, connecting a tenant, credential rotation, dead-job alerting, restore, and
  an intern workbook. It marks what is externally blocked rather than implying a
  rehearsal happened.
- `docs/work-requests/CLAUDE-MULTI-MARKET-PHASE-6-PROMPT.txt` — the shared-file record
  (SF-01 to SF-12): every schema, registry, scheduler and enum change, why it was made
  and which migration carries it.
- `docs/screenshots/phase-6/` — browser verification of the nine new screens at desktop
  and phone widths, for both a jewellery tenant and a generic (healthcare) one, plus the
  head-office-only denial. Untracked; delete or commit as you prefer.

Five additive migrations were added (20260909150000 to 20260909190000). They have been
applied from zero and to a populated clone; `backend/scripts/backfill-ad-spend.mjs`
moves the historical LegacyRow advertising spend into the new typed models and is
idempotent.

What still cannot be verified here: anything requiring a reviewed Meta app. See the
runbook's final section.

## 2026-09-07 — CURRENT STATE (read this first; everything below it is older)

**The product is now CaratOS**, a multi-tenant platform. Eclat is Organisation #1 and
the reference implementation, and must keep working at every step. The sections further
down this file predate that pivot — in particular, **"Frontend — BUILT (2026-06-17)"
below is out of date where it says the frontend is mock-only**: it has been wired to the
real API since July. Treat anything below this block as history.

### Worktree
The CaratOS implementation is **uncommitted** — the last commit is `9589ac5` (2026-08-19).
Roughly 250 changed/untracked files carry user-owned work. Do not reset, revert or clean.

### Today's change (P0-A: CTWA ad routing)
The ad-set routing engine existed but was **unreachable** — nothing supplied a routing
context to `ingestInbound`, so no rule could fire. Meta's CTWA `referral` was already
stored verbatim in `WhatsAppEvent.payload` and never read.

Now connected: `integration/contracts/ad-referral.ts` (neutral contract) →
`integrations/meta-referral.ts` (Meta adapter) → `whatsapp-bot.service.ts` →
`conversations.service.ts` → rule match → store/handling → Lead (only with a real store)
→ `measured` AttributionTouch. Migration `20260907120000_crm_ad_referral_routing`
(additive, rehearsed zero-to-current).

**Tested with a sanitized fixture of the documented CTWA shape — NOT with live Meta
traffic.** A real ad, app review and a live webhook are still required.

### CRM Phase 2C — provider-backed AI drafting (2026-09-07, latest session)
The `AI_RESPONDER` seam now has a real adapter behind it (Anthropic or an
OpenAI-compatible endpoint, chosen by `CRM_AI_PROVIDER`/`CRM_AI_MODEL`/
`CRM_AI_API_KEY`; absent credentials leave it unconfigured and everything hands
off to people, exactly as before).

What the gate now does, in order: refuse for `human`/`unassigned`; refuse if the
tenant has not switched drafting on; refuse if no provider; **screen** the
message for complaints, opt-outs and legal mentions BEFORE any provider call;
**retrieve** from the tenant's knowledge and refuse to draft if nothing matched;
then call the provider, and discard anything under 0.55 confidence or flagged
`needsHuman`. Every refusal sets `handling='human'` with a reason.

A successful draft writes a `Message(status='draft')` and an `AiDraftRecord` in
ONE transaction: provider, model, confidence, latency, policy version and the
knowledge document IDs. Approve/edit/reject live at `/crm/ai/drafts/:id/...`,
are `@HumansOnly()`, and approving moves the message to **queued** — never
`sent`. Rejecting sets **rejected**, deliberately not `failed`.

**Two defects found while building it:**
1. `KnowledgeService.search` substring-matches the WHOLE query, so a natural
   question ("what are your opening hours") retrieved nothing and the assistant
   would have handed off on essentially every message. The CRM side now searches
   by content word. See REQ-005 — the real fix is ranked retrieval in
   KnowledgeService.
2. A bare `stop` opt-out rule fired on "Where is the nearest bus stop?".
   Narrowed to a whole-message STOP or "stop messaging/texting/calling".

**Contract change to be aware of:** the gate will not call a provider with no
supporting material. Two Phase 1 tests asserted the old behaviour and were
updated to seed a knowledge document — the assertions themselves are unchanged.

### CRM Phase 2B — queues, assignment, routing conflicts (2026-09-07, latest session)
The queue tabs existed but nothing could act on what they showed: there was no way to
reassign a conversation from the UI and no way to decide a routing conflict. Both exist
now, and four defects were found and fixed on the way:

1. **`PATCH /crm/conversations/:id` could set `assignedUserId`** with no store-membership
   check and no role gate, which made the new rank on `/assign` decorative. The field is
   gone from the DTO; ownership has exactly one door.
2. **Conflict resolution had a read-then-check race.** Two managers deciding in the same
   second both passed. It is now `UPDATE … WHERE resolution IS NULL`, with the claim
   released if the assignment is then refused.
3. **`accepted_proposed` cleared the location** when the proposing rule had no store,
   evicting a routed thread into the head-office-only central queue.
4. **`load()` had no `include`**, so the conversation detail header showed "Unknown
   sender" for every thread — and routing audit rows carried no store, making routing
   history invisible to the store manager it concerned.

New: `GET /crm/conversations/queues` (server-side counts), `GET
/crm/conversations/routing-conflicts?state=open|resolved|all&conversationId=` (names
resolved, history kept), `AssignConversationDialog`, `RoutingConflictPanel`. Queue and
thread selection now live in the URL.

**Verified:** the CRM regression (phase1, phase1b, phase2b, ctwa, requalification,
adset-rules, auth-rate-limit) **81/81, 7/7 suites** on a database migrated from zero,
with the unmodified `test/jest-e2e.json` and no `--forceExit`; `whatsapp-bot` 11/11
against the seeded `eclat_preview`; backend `tsc` 0 errors and `nest build` exit 0;
frontend `tsc`/eslint/`next build` all clean; plus every flow driven in a real Chrome
over CDP (queue badges matching the API, `?queue=`/`?thread=` deep links, an assignment
that moved the header from "North Branch · Nadia Rep" to "South Branch · South Manager",
and a conflict resolution that dropped the review badge 1 -> 0).

**Environment gotchas hit this session, both worth knowing:**
- A `prisma generate` that fails on the Windows DLL lock leaves a client that reports
  *"the URL must start with the protocol `prisma://`"* — which reads like an Accelerate
  misconfiguration and is not. The DLL was held by an ORPHANED jest process (no CPU, no
  listening port, hours old); killing that one process and re-running `prisma generate`
  fixed it. Identify the holder before killing anything:
  `Get-Process node | ? { $_.Modules.FileName -contains $dll }`.
- Next 16 blocks cross-origin `/_next/` dev assets, so opening the dev server on
  `127.0.0.1` instead of `localhost` serves the SSR shell and never hydrates — the page
  looks blank with no console error. Use `localhost`, or set `allowedDevOrigins`.

**Known limit:** `whatsapp-bot` depends on the seeded `org_eclat` users, so it cannot run
on a fresh zero-to-current database while `prisma/seed.mjs` stays stale (it sets
`organisationId` zero times against a NOT NULL column on 47 models). `eclat_dev` is also
behind on migrations — the app will not boot against it until `prisma migrate deploy`
is run there.

### CRM Phase 1 hardening (2026-09-07, later session)
Five verified defects in the CTWA path were fixed, each with a test that was proven
to fail against the old code:
- **Lead reuse ignored the routed store** — a Hyderabad ad could attach to an open
  Mumbai lead. Now scoped to `organisationId + partyId + storeId + open`.
- **Ad clicks produced anonymous leads with no phone** — now resolve/create a
  tenant-scoped Party + ContactPoint (`IdentityService.resolveInbound`, P2002-safe
  against webhook retries). Non-ad traffic still stays anonymous by design.
- **A later ad silently moved an active thread** to another branch. First routing
  now wins; conflicts set `Conversation.routingReviewRequired` and log an activity event.
- **Attribution could double-count** — `AttributionTouch.dedupeKey` + unique index
  on `(organisationId, dedupeKey)`.
- **"AI vs human" was an unread string** — `ConversationAiGate` + provider-neutral
  `AiResponder` (`AI_RESPONDER` token) now enforce it. Tenant switch
  `crmAiAutoReplyEnabled` is **off by default**; AI replies are stored as drafts and
  **nothing is ever delivered**.

Migration `20260907140000_crm_attribution_dedupe_routing_review` (additive, rehearsed).

**Still not built:** conversational AI provider adapter (interface + fake only),
Meta Lead Ads ingestion, requalification-after-inbound, ROAS reporting.

### CRM Phase 1 residual + Phase 2A (2026-09-07, later session)

Fixed, each with a test proven to fail against the old code:
- **1A** automatic routing no longer seizes a MANUALLY assigned thread (the old
  test was `!matchedRuleId`; a hand-assigned thread has no rule).
- **1B** `ConversationRoutingConflict` table + resolve action (keep / accept /
  manual). The review flag can now be cleared; history is retained.
- **1C** `Lead.originKey` + unique `(organisationId, originKey)` — concurrent
  deliveries of one click can no longer create two leads.
- **1D** message creation catches P2002 and returns the winner, so a racing
  redelivery creates no second lead, touch, party or AI draft.
- **1E** `POST /crm/conversations/:id/assign` — store, owner and handling move
  atomically, and an assignee must actually work at the destination store.
- **1F** the central storeless queue is **head office only** (fail closed —
  `User` has no region link). Applied in `list()` AND `load()`.
- **1G** three separate AI switches, all default off, merged into settings
  without clobbering. `GET/POST /crm/qualification/ai-settings`.
- **1H** conversations page lint fixed by deriving state from the URL (keyed
  remount) instead of syncing it in an effect.

**2A** requalification: `RequalificationService` registers a `crm.requalify`
job, debounced per conversation via the queue's `idempotencyKey`. Never on a
replay; off unless `crmAiQualificationEnabled`.

**Test database (Part 3):** `npm run test:db:setup` / `test:e2e:isolated`.
`scripts/test-db.mjs` refuses to create or drop anything not ending in `_test`
or `_rehearsal`, with `eclat_dev`/`eclat_preview`/`postgres` on a never-touch
list. **Blocked:** `prisma/seed.mjs` predates multi-tenancy (sets
`organisationId` zero times) so legacy seeded suites cannot run on a fresh
database. CRM suites build their own tenants and pass there — 51/51, no
`--forceExit`.

**Not built:** conversational AI provider adapter (interface + fake only), Meta
Lead Ads ingestion, ROAS reporting, routing-review UI, draft-approval UI.

### The blockers that gate go-live (from the Phase C verification, 2026-09-03)
1. The on-site sync agent still logs in as a **head_office user** (`sync@caratsense.in`),
   so a password in a `.bat` file on a shop PC reaches `/sync/reset` and `/sync/purge-demo`.
   The ConnectAgent machine-credential path is built and tested but **not adopted**.
2. **No verified database backup** — nothing in the repo, no restore ever drilled.
3. Committed bcrypt hashes for the two most privileged accounts, seeded into every fresh DB.
4. Cross-tenant media key collisions: the sync agent writes flat `catalogue/{legacyId}`
   keys outside the tenant namespace.
5. R2 read+write bucket credentials sit on every client PC.
6. `caratos_org_not_null` does 47 `SET NOT NULL` + 47 FK rebuilds under `ACCESS EXCLUSIVE`
   while the API serves traffic — the most dangerous item in the deploy queue.

RLS: 70 policies exist and are **deliberately disabled** (per-request tenant context is
not wired; enabling would take the app down, not leak). Do not enable.

### Local databases
`eclat_preview` is the test database — run suites with an explicit `DATABASE_URL`
override. `.env` still points at the stale `eclat_dev`. Rehearse migrations on a
disposable database (`eclat_rehearsal_*`), never against production.

## 2026-06-24 — Spec audit + "Assay" design system + Éclat Diamonds brand
- **Audit** of the codebase vs the build spec written to `docs/AUDIT.md` (evidence-based; verdict: demo-workable, production-workable for in-store web ops; blockers = scheduler/email/quote→order/mobile-app). Stack confirmed: NestJS+Prisma+Postgres backend, Next.js 16 web (no mobile app), RBAC globally enforced, frontend renders live API (mock = types only).
- **Design system** `docs/DESIGN_SYSTEM.md` ("Assay"): dropped indigo → ONE gold accent; 3 faces (Fraunces display · Inter UI · Geist Mono tabular `.num`); signature `.facet-top` gold light-catch; warm porcelain/graphite; jewel charts. Tokens in `globals.css`, fonts in `layout.tsx`.
- **Brand alignment to eclatdiamonds.in:** added emerald `--brand` `#0F2A1E` (+ `.emerald-panel`). Sidebar rail is now emerald with the gold "Éclat Diamonds" wordmark. **New public landing page at `/`** (was a redirect) and a **split-screen sign-in at `/login`**, both emerald + gold + serif.
- **Mobile:** real bottom tab bar (`components/layout/mobile-nav.tsx`) replaces the top hamburger; 4 thumb tabs + More sheet, 44px targets.
- **All 18 screens:** tabular `.num` numerics + loading/empty/error states (4 frontend agents). Verified: `tsc --noEmit` clean; live screenshots of landing/login/dashboard/8 modules + mobile = **0 console errors**. Screenshots in `shots-v2/` (`rb-*`, `tour-*`).

## Frontend — BUILT (2026-06-17) ✅
Next.js 16 + React 19 + TS + Tailwind v4 + shadcn/ui app at `E:\Eclat Project\frontend`. Run: `cd frontend; npm run dev` (→ http://localhost:3000 → `/dashboards`). Verified green: `tsc --noEmit`, `npm run lint` (1 trivial warning), `npm run build` (21 routes, exit 0).
- **App shell:** sidebar nav (all 17 modules grouped by domain), top bar with **store switcher** + **role badge** (Salesperson/Store Manager/Area Manager/Head Office, switchable to demo role-based views), theme toggle. Session state in `src/store/use-session.ts`.
- **All 17 module sections built** with realistic Indian-jewelry mock data (₹/grams/carats via `src/lib/format.ts`), role/store-scoped: CRM kanban, Catalogue + AI image-search affordance, Quotation builder w/ pricing breakdown, Returns photo-intake + exchange calc, Discounts role-limit approval + margin preview, Loyalty maturity calc, Timelines stepper, Inventory aging/rotation/scrap, Payments ledger + reconciliation, HRMS geo-attendance + leaderboard + commission, Check-ins footfall, Dashboards (default landing), Finance, Reporting/DSR, New-store checklists, Marketing, Ticketing.
- **Still mock-only:** all data is from `src/lib/mock/*`; not wired to a backend yet. API client seam in `src/lib/api.ts`. Auth/session seeded mock. PWA + WhatsApp actions are stubs.
- **Next on frontend:** wire react-query hooks to the real backend once it exists; role-gate rendering via `ROLE_RANK`; add PWA/geolocation for HRMS.

## What this project is (30-second version)
**Eclat** (product name **CaratSense**) = one unified operations platform for a **multi-store jewelry retail chain**, covering sales, inventory, finance, HR, and customers across all branches. It is **not greenfield** — it replaces/extends an existing jewelry ERP called **APRS-SJEP** (SQL Server). Full idea & flow are below; full spec is in `docs/MODULES.md`.

## The product in one diagram (customer + product flow)
```
Inquiry (web/walk-in/phone/social)        → M1 CRM & Lead Mgmt
   → Customer check-in, rep assigned       → M7 Footfall, M6 HRMS
   → Browse catalogue (+ AI image search)  → M5 Catalogue
   → Quotation (priced, WhatsApp, portable) → M2 Quotation & Pricing
   → Discount within role limits           → M15 Discount
   → ORDER ── in-stock ──┐
            └ custom ──→ factory: melt→design→set→ready → M8 Timelines
   → Payment (cash/card/UPI/online/scheme) → M12 Payments, M17 Gold Scheme
   → Delivery / collection
   → Returns / exchange / repair (photo)   → M14 Returns
Continuous: M9 Inventory, M4 Finance, M3 Dashboards, M10 DSR,
            M11 New-store setup, M16 Marketing, M13 Ticketing
```
17 modules total. Grouped: **Front-of-house** (1,2,5,7,14,15,17) · **Back-of-house** (6,8,9,12,13) · **Boardroom** (3,4,10,11,16).

## Decisions locked (also in docs/DECISIONS.md)
- ❌ **CCTV footfall analytics (was in Module 7) — DROPPED.** Footfall = manual/tablet check-in only.
- ✅ All other 16 modules + non-CCTV Module 7 are **in scope**.
- 📄 Docs strategy: keep `CLAUDE.md` + `docs/MODULES.md` + `docs/DECISIONS.md`. **No per-module files upfront** — create `docs/modules/NN-slug.md` on demand when a module's build starts (saves tokens).

## Open points — NOT yet decided (need the owner)
- **OP-1 (Module 8):** Is the customer order-status timeline shown to customers, or internal-only?
- **OP-2 (Module 2):** Pricing source of truth — gold-rate feed, making-charge rules, store overrides?
- **OP-3 (architecture):** Eclat = net-new app or extend APRS-SJEP? + migration approach from `SJEP BACKUP/`.

## Agents set up — FULL TEAM (see docs/AGENTS.md)
Role specialists in `.claude/agents/`: **tech-lead** (planner/PM), **db-migrator** (legacy DB), **database-architect** (Eclat Postgres), **backend-engineer** (NestJS), **frontend-engineer** (Next.js PWA), **integrations-engineer** (WhatsApp/Razorpay/sync), **jewelry-domain-expert** (pricing/domain), **security-auditor** (cyber), **qa-engineer** (QA), **devops-engineer** (Railway/Vercel/infra). Standard module flow + orchestration notes in `docs/AGENTS.md`. Built-ins: Explore, Plan, and the `/code-review` skill.

## Existing system files (READ-ONLY — never overwrite/delete)
- `SJEP DATA/APRSLog.mdf` (+ `.ldf`) — live DB data files.
- `SJEP BACKUP/APRS-SJEP-<timestamp>/` — dated full backups. Main DB = `APRSSJEP.bak` (~100 MB). Use the **latest** timestamp.
- `SJEP REPORT/Reports/*.repx` — DevExpress report templates (reveal real table/column names).
- `SJEP REPORT/Eclat_RequirementsNotes_CaratSense.pdf` — detailed requirements.
- `Eclat_feature planning.xlsx`, `Jewel Modules - Google Sheets.pdf` — planning sources.

## Environment notes (machine-specific — re-check on the new laptop)
- Original dev box (Windows 11): **no SQL Server installed**, no Docker, but **winget available**.
- To read the legacy DB you must first stand up an engine: `winget install` SQL Server Express + `sqlcmd`, OR use Docker `mssql`, then restore a **copy** of `APRSSJEP.bak` into a throwaway DB. Never touch the original files.
- ⚠️ On the new laptop, re-verify these (SQL Server / Docker / winget may differ).

## Data pipeline (DECIDED 2026-06-16)
**Hybrid:** one-time `APRSSJEP.bak` backfill + a live read-only SQL Server **sync agent** on the client's office PC (every 15 min, pushes changes to Eclat). This mirrors the **proven** Busy→CaratSense sync built for the **Ashish Textile** client (`...\OneDrive\Desktop\ashish textile\data_sync\CaratSenseSync\auto_sync_busy.py`) — repointed from MS Access to SQL Server. Full design in `docs/DATA_PIPELINE.md`. Skeleton already written: `data_sync/EclatSync/sync_sjep.py` (framework done; `extract_*()` SQL bodies marked TODO until the schema is known).

## Legacy schema — EXTRACTED (2026-06-16) ✅
SQL Server 2022 Express is installed (`localhost\SQLEXPRESS`); the June 8 `APRSSJEP.bak` is restored as throwaway DB **`APRSSJEP_eclat`** (ONLINE). Full schema in **`docs/legacy-schema.md`**. Postgres 18 is also already running on this box (Eclat target DB).
- To re-query: `Import-Module 'C:\Users\Shrey\Documents\WindowsPowerShell\Modules\SqlServer\22.4.5.1\SqlServer.psd1' -Force` then `Invoke-Sqlcmd -ServerInstance 'localhost\SQLEXPRESS' -TrustServerCertificate -Database 'APRSSJEP_eclat' -Query "..."`.
- **Key facts:** 1,102 tables but ~150 hold real data (~920 dormant). Two hubs: **`PartyMst`** (all customers/suppliers/staff/branches) and **`Inward`** (one row per jewellery piece; `InwardSummary` = weights/amounts). Sales/purchase = `JewelTrans` (TranType-driven). Manufacturing = `Spm_MfgOrder`→`SPM_BagMaster`. Accounting = `Journal`/`VoucherEntry`/`Heads`.
- **Data looks recent (Mar–Jun 2026 only)** — possibly a fresh/seeded install, not years of history. ⚠️ CONFIRM with client whether this is their full data or a test instance (affects backfill expectations).
- **Reusable legacy coverage:** M4 Finance (full ledger), M5 Catalogue, M9 Inventory, M2 pricing (rate charts + labour/CPF). **Net-new (no legacy data):** M3 Dashboards, M6 HRMS, M7 Check-ins, M13 Ticketing, M16 Marketing; M1 CRM & M17 Loyalty have schema but ~no data.
- **Sync watermarks:** identity bigint PK + `UpdateDate`/`EntryDate` on every transaction table (e.g. `JewelTrans.JewelTransId`+`UpdateDate`, `Inward.JewelId`+`UpdateDate`). Cancellations are soft (`isCancel` bit) — re-pull by `UpdateDate`, don't rely on deletes.

## Backend + full-stack slice — LIVE (2026-06-17) ✅
- **Backend:** NestJS at `E:\Eclat Project\backend` on port **4000**, Prisma → Postgres `eclat_dev` (creds `postgres:postgres@localhost:5432`). Run: `cd backend; npm run start:dev`. 45-table schema (`prisma/schema.prisma`), migration applied, seeded demo data. JWT auth, RBAC + store-scoping (`src/common/store-scope.service.ts`), server-side quote pricing, discount escalation. Demo logins in `backend/README.md` (password `password123`): `head.office@caratsense.in`, `priya.rep@caratsense.in`, etc.
- **Endpoints live:** `/auth/login`,`/auth/me`,`/stores`,`/leads`(+CRUD/stage),`/products`,`/quotes`(+POST),`/stock`,`/dashboard/kpis`,`/dashboard/charts`,`/discounts`(+POST). Auth header `Bearer`, active store via `X-Store-Id` header. Store ids: `surat-main`,`mumbai-bandra`,`ahmedabad-cg`,`all`.
- **Frontend wired** to backend for 6 modules (Dashboards, CRM, Catalogue, Quotation, Inventory, Discounts) via `src/lib/queries/*`; real `/login` + session gate + logout; store switcher refetches. Verified store-scoping end-to-end (HO 8 leads / Surat 4).
- **Still on MOCK (need backend endpoints):** checkins, finance, hrms, loyalty, marketing, new-store, payments, reporting, returns, ticketing, timelines (marked `// TODO: wire to backend`).
- **Design:** Notion/Airtable, Inter font, Airtable-blue accent, ECharts for all charts. (Earlier luxury-gold-serif look was rejected & replaced.)

## ALL 17 MODULES LIVE + HARDENED + REAL DATA (2026-06-17) ✅
- **All 17 modules** now have real NestJS endpoints + wired frontend (no more mock). Backend `start:prod` on :4000, frontend `npm run dev` on :3000.
- **Real legacy data backfilled** into `eclat_dev`: 564 parties, 753 products, 2,690 stock pieces, 239 sales, 3,275 sale lines, 121 mfg orders (`backend/scripts/backfill-legacy.mjs`, idempotent on `legacyId`).
- **Security hardened:** audit fixed mass-assignment (forbidNonWhitelisted), JWT-secret fail-fast, finance role-gating; CORS now env-driven (`CORS_ORIGINS`). Verified: finance 403 for reps, cross-store 403, mass-assign 400.
- **Tests:** 25 e2e tests pass (`cd backend; npm run test:e2e`) covering auth, store-scoping, RBAC, discount limits, quote pricing. No defects.
- **Sync:** real `extract_*()` SQL in `sync_sjep.py` (validated vs restored legacy DB); production sink = Eclat REST bulk-upsert or direct PG load (route still to build).
- **Deploy-ready:** Dockerfiles (backend+frontend), `railway.json`, `vercel.json`, CI (`.github/workflows/ci.yml`), runbook `docs/DEPLOYMENT.md`, sync-agent installer `data_sync/EclatSync/setup.bat`.

## INTEGRATIONS (Phase 4) — CODE-COMPLETE behind env keys (2026-06-23) ✅
`backend/src/integrations/` — a `@Global` NestJS module wrapping the three external touchpoints. **No new dependencies** (Node global `fetch` + built-in `crypto`). Every integration degrades to a logged **`dryRun`** no-op until its credentials are set, so the app runs identically with or without them and **activates the moment env vars are filled** (no code change).
- **WhatsApp** (`whatsapp.service.ts`): Cloud/Graph API `sendText` + `sendTemplate` (auto-normalises Indian numbers to `91…`); webhook GET handshake (verify-token) + POST inbound with `X-Hub-Signature-256` HMAC check. Live when `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` set.
- **Razorpay** (`razorpay.service.ts`): `createPaymentLink` (amount in paise, attribution carried in `notes`); webhook is HMAC-verified (`X-Razorpay-Signature`) and **idempotently records a `Payment` row** (mode=`online`, deduped on the rzp payment id in `Payment.reference`). Live when `RAZORPAY_KEY_ID/SECRET` set; webhook needs `RAZORPAY_WEBHOOK_SECRET`.
- **Gold rate** (`gold-rate.service.ts`): `refresh()` pulls fine-gold spot from `GOLD_RATE_API_URL` and writes a `MetalRate` row per purity (24k/22k/18k/rose); auto-detects 3 feed shapes (generic `inr_per_gram`, goldapi.io `price_gram_24k`, metals.dev per-ounce). `getLatestRate()`/`currentRates()` fall back to last stored rate (also what the legacy backfill/sync populate) — quotes keep working with no live feed.
- **Endpoints** (all under `/integrations`): `GET status` (which are live), `POST whatsapp/send`, `GET|POST whatsapp/webhook` (@Public), `POST razorpay/payment-link` (store-scoped), `POST razorpay/webhook` (@Public, signature-gated), `GET gold-rate`, `POST gold-rate/refresh` (manager+). Webhooks need raw bytes → `main.ts` now boots with `{ rawBody: true }`.
- **Tests:** `backend/test/integrations.e2e-spec.ts` — 10 e2e (dry-run, auth, RBAC, store-scope, mass-assign guard, webhook-signature rejection). **Full suite now 35/35 green.** New env vars documented in `backend/.env.example` (`WHATSAPP_APP_SECRET`, `GOLD_RATE_API_KEY`, optional `WHATSAPP_API_VERSION`).

## BLOCKED on external dependencies (cannot finish locally)
- **Real-time sync on-site:** needs read-only access to the client's LIVE SQL Server (`APRSSJEP`) on his office PC + TCP enabled. Queries are ready.
- **WhatsApp / Razorpay / gold-rate:** integration code is **DONE** (see Phase 4 above) — only need client accounts + API approvals, then fill the env vars in `.env.example`. Nothing left to build.
- **Actual deploy:** needs Railway + Vercel + object-storage (R2) accounts. Apply CORS_ORIGINS=real domain on deploy.
- **Open product decisions:** OP-1 (timeline visibility), OP-2 (pricing source), OP-4 (area-mgr new-store region scope), OP-5 (HRMS commission self-vs-all), OP-6 (live-data code decodes), + confirm legacy data completeness (looks like a fresh install).

## SYNC INGESTION ROUTE — BUILT + AGENT WIRED (2026-06-23) ✅
The last data-pipeline piece is done. `backend/src/sync/` — per-entity bulk-upsert routes the on-site agent pushes to.
- **Routes** (`POST /sync/<entity>`, **head_office-gated**): `parties, products, stock, sales, sale-lines, orders, order-items`. Body `{ records: [...] }` of raw legacy rows; each upserts on its unique `legacyId`. Mapping is **ported verbatim from `scripts/backfill-legacy.mjs`** (`sync.util.ts`) so live-sync and backfill converge on identical Eclat rows. Idempotent; FKs (sale→party, line→sale/stock, item→order) resolved against already-synced rows. Returns `{received, upserted, skipped, watermark}`.
- **Agent wired:** `data_sync/EclatSync/sync_sjep.py` production sink now POSTs to `/sync/*` in dependency order (`push_chunked`, 3000-row chunks, JSON-serialising datetime/Decimal) and **only advances the watermark after every entity succeeds** (partial failure re-pulls next cycle). Replaced the old `/upload/excel` stub.
- **Tests:** `backend/test/sync.e2e-spec.ts` (5: RBAC gate, idempotent upsert, watermark, FK-skip, mass-assign guard).

## FULL-STACK VERIFIED RUNNING (2026-06-23) ✅
Both servers run together end-to-end. Backend :4000 (watch), frontend :3000 (Next 16). Logged in as head office, **all 17 module pages render authenticated against the live backend with real legacy data — 0 console errors, 0 failed requests, no login bounces** (verified via headless Chrome over every route; screenshots in `Eclat/shots/`).
- **Fix — default store:** `auth.service.ts` now lands broad roles (head office / area manager) on the **"All Stores"** aggregate instead of the first store alphabetically (better UX + pan-India default view). Single-store users unchanged.
- **Fix — finance duplicate React key:** `/finance/ledger` view now exposes a unique `key` (DB id) separate from the human `id` (ref, which repeats across stores); `LedgerTable` keys on it. Cleared the only console warning found.
- **e2e: 40/40 green** (25 core + 10 integrations + 5 sync).
- Note: e2e runs leave "QA Test" quotes in `eclat_dev` (harmless demo noise); the sync test leaves `TEST-SYNC-PARTY-1`.

## PHASE 2 (photos) + OPEN DECISIONS CLOSED (2026-06-23) ✅
- **Decisions locked** (see DECISIONS.md): OP-1 timeline = internal-only; OP-2 pricing source = `MetalRate` table; OP-4 area-mgr new-store = region-scoped; OP-5 HRMS commission/leaderboard = salesperson self-only; images = pluggable storage (local-disk dev, R2-ready); AI image search = Claude vision + rule-based (per [[feedback_no_ml]]).
- **Photos pipeline (Phase 2) — BUILT & live:** `backend/src/storage/` (`StorageService`, local-disk provider, R2-ready) + `POST /products/:id/image` (manager+, multipart, ≤8MB) + static serving at `/uploads` (`main.ts` now `NestExpressApplication.useStaticAssets`). Frontend: `assetUrl()` helper, product **card + detail dialog render the image** (gem fallback) with a manager-only **Upload** control (`useUploadProductImage`). `scripts/seed-cover-images.mjs` generated 6 metal-tinted SVG covers and assigned them to all **763 products** (only where imageUrl empty) — catalogue now shows premium imagery end-to-end through the real storage pipeline. New env: `UPLOAD_DIR`.
- **OP-4 implemented:** added `NewStoreProject.regionId` (migration `new_store_region`), `/new-store/projects` filters by the area manager's region(s); HO sees all. Backfilled regionId on existing projects.
- **OP-5 implemented:** `/hrms/commission` & `/hrms/leaderboard` self-filter for salespersons.
- **Verified:** backend builds clean; **40/40 e2e green**; catalogue re-screenshot shows photos.
## PHASE 2 WRITE-FORMS — COMPLETE (2026-06-23) ✅
Every module's primary "create" action is now a real working form (was toast-stub).
- **Already existed** (POST endpoint + form): CRM New Lead, Quotation New Quote, Discounts Request, Loyalty Enroll, Returns New Intake, Check-ins Log, Ticketing New Ticket.
- **Built this pass** (5 new, full-stack, via parallel subagents, following the New-Lead pattern): **Catalogue Add Product** (`POST /products`, manager+, dup-SKU guarded), **Payments Record Payment** (`POST /payments`, store-scoped), **Inventory Stock Entry** (`POST /stock`, manager+), **Marketing New Campaign** (`POST /marketing/campaigns`, manager+), **Finance Add Entry** (`POST /finance/ledger`, manager+). Each: DTO (whitelist-strict) + service `create` with `assertStoreAllowed` + Decimal-wrapped money + reuse of the module's view shape; frontend `useCreate*` mutation (invalidates the list key) + co-located `Add*Dialog` wired to the SectionHeader CTA.
- **Verified:** backend `nest build` clean · **40/40 e2e** · frontend `tsc --noEmit` clean · all 5 endpoints return **201**, validation guard returns **400** on extra fields · "Add Product" dialog screenshot confirms the UI. Verify rows cleaned up.
- **Lower-value CTAs still stubbed (by design, need new domain models):** Dashboards "New Task", Timelines "New Workflow", New-Store "launch wizard" — toast stubs; not transactional, deferred.

## PHASE 2 FORMS + PHASE 3 (AI SEARCH) + PHASE 5 — COMPLETE (2026-06-23) ✅
- **Phase 2 write-forms — DONE.** All five missing transactional creates built (Add Product `POST /products`, Record Payment `POST /payments`, Stock Entry `POST /stock`, New Campaign `POST /marketing/campaigns`, Add Ledger Entry `POST /finance/ledger`) + the seven that already existed (CRM/Quotation/Discounts/Loyalty/Returns/Check-ins/Ticketing). All endpoints verified 201; validation guard 400; "Add Product" dialog screenshotted.
- **Phase 3 — AI image search — DONE.** `backend/src/products/ai-image-search.service.ts` + `POST /products/image-search` (multipart). Uses **Claude vision over raw fetch** (model `claude-opus-4-8`, `output_config.format` json-schema) to tag category/metal/keywords, then **rule-based** ranking against the store-scoped catalogue. Code-complete behind `ANTHROPIC_API_KEY`; with no key it degrades to a rule-based "best matches" view (`aiUsed:false`). Dependency-free (matches the integrations pattern; no `@anthropic-ai/sdk`), aligns with [[feedback_no_ml]] (Claude is the only AI; matching is rule-based). Frontend `image-search.tsx` wired to the live endpoint (shows detected chips + similarity badges). Verified: endpoint returns 201 with 12 ranked matches on the fallback path.
- **Phase 5 — deploy config — DONE (code-level).** `main.ts` CORS already reads `CORS_ORIGINS` (prior follow-up resolved). `.env.example` complete with every integration + storage + AI key. Storage = local-disk provider, production-viable on a Railway **persistent volume** (`UPLOAD_DIR` → mounted path); R2/Cloudinary remain an optional provider swap. **Actual hosting (Railway + Vercel + R2 accounts) is the only external step left.**
- **Verified end-to-end:** backend `nest build` clean · **40/40 e2e** · frontend `tsc --noEmit` clean · **17/17 pages render authenticated, 0 console errors** (full headless-Chrome pass).

## EVERY BUTTON FUNCTIONAL + PROFILE/SETTINGS (2026-06-23) ✅
- **All 17 modules' primary actions are now real forms** (verified via headless-Chrome clicks: 17/17 open a dialog/flow). The last 5 toast-stubs were wired: **Dashboards New Task** (`Task` model + `GET/POST /dashboard/tasks` + "My Tasks" card), **HRMS Mark Attendance** (`POST /hrms/attendance`), **Reporting Generate DSR** (DSR-summary dialog + "Send to owner" → WhatsApp dry-run), **Timelines New Workflow** (`POST /timelines/workflows` → CustomOrder), **New-Store New Project** (`POST /new-store/projects`).
- **Profile & Settings page** — new `/settings` route (linked from the user menu): Profile (avatar/role/assigned stores), **Security → Change password** (`POST /auth/change-password`, bcrypt-verified — wrong current pw returns 401), Preferences (theme + default store).
- **Google Sign-In — ADDED (2026-06-23, owner reversed the earlier "no Google" call).** `POST /auth/google` verifies a Google ID token (via Google's tokeninfo endpoint — checks `aud` = `GOOGLE_CLIENT_ID` + `email_verified`), then matches an **existing active user by email** (NO auto-provisioning — admin provisions users, Google just authenticates). Same JWT session as email login. Frontend `GoogleSignInButton` (Google Identity Services) sits on the login page below the email/password form. **Code-complete behind keys:** set `GOOGLE_CLIENT_ID` (backend) + `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (frontend, same id from Google Cloud Console) to enable; until then the button hides and `/auth/google` returns 400. Email/password login + change-password unaffected. Verified: route returns 400 when unconfigured, login page renders 0 errors, build + tsc + 40/40 e2e clean.
- **New migration:** `dashboard_tasks` (the `Task` model).
- **Verified:** backend `nest build` clean · frontend `tsc --noEmit` clean · **40/40 e2e** · all 5 new endpoints respond (201; change-password 401 on wrong pw) · Settings renders (0 console errors, no Google) · test rows cleaned.

## ▶ REMAINING — all external / non-code
1. **Go live:** create Railway (backend + Postgres) + Vercel (frontend) + R2 accounts; set the real env vars (incl. `CORS_ORIGINS`=prod domain); deploy. Everything is packaged.
2. **Flip integrations on:** add WhatsApp / Razorpay / gold-rate / `ANTHROPIC_API_KEY` credentials — all code-complete behind keys.
3. **On-site sync:** point `sync_sjep.py` at the client's live `APRSSJEP` SQL Server (read-only, TCP) using a head_office service account.
4. **OP-6:** confirm legacy `TranType`/`OrderStatus` decodes against live data; confirm whether the legacy DB is full or a fresh install.

## ▶ EXACT NEXT STEP (where we left off)
Both remaining engineering pieces (Phase 4 integrations + `/sync` route) are DONE and the full stack is verified running. What's left is **non-code / external**:
1. **Open product decisions** (no DB needed): **OP-1** (timeline visibility), **OP-2** (pricing source — legacy rate-chart/labour/CPF tables are the likely source of truth; the Phase-4 `MetalRate` feed is the live-rate half), **OP-4/OP-5** (role visibility), and the **Twenty CRM adopt-or-not** decision.
2. **External credentials** to flip integrations live: WhatsApp / Razorpay / gold-rate accounts → fill `.env`. On-site sync needs read-only access to the client's live `APRSSJEP` SQL Server (TCP enabled) + a head_office sync service account.
3. ⚠️ Confirm with client: is the legacy data a full dataset or a fresh/test install?

Also still open: whether to **adopt Twenty CRM** as the customer/sales core (M1 + parts of 2,3,8,15,17) vs. build custom — and the **AGPL-3.0** license question if adopted. (User was mid-decision; build on its apps framework = AGPL-safe.)

**To resume:** read this file + `CLAUDE.md` + `docs/MODULES.md` + `docs/DECISIONS.md` + `docs/DATA_PIPELINE.md`, then continue with step 1 (the `/sync/*` route), or ask which fork.

## MULTI-MARKET PHASE 2 — ENFORCEMENT (2026-09-08)

The industry layer stopped being cosmetic. Phase 1 made the product *look* right
per industry; this made it *be* right.

**Where the policy lives now**

- `backend/src/config/entitlements.ts` — request path → capability (a navigation
  slug), allow-by-default, longest-prefix match. One screen of code; the whole
  module policy is readable in it.
- `backend/src/common/entitlement.guard.ts` — registered in `app.module.ts`
  beside `RolesGuard`. Skips machine principals (the Connect agent contract is
  not ours to redecide) and `@Public()` routes.
- `frontend/src/components/layout/module-gate.tsx` — mounted once in the (app)
  layout. Not the security boundary; it exists so a clinic that types `/finance`
  sees an explanation instead of a rendered page whose every panel 403s.

**Things that will surprise you**

- `checkins` moved into `CORE_NAVIGATION`. Every pack already seeded a
  `checkin_purpose` vocabulary with its own visit labels, which only makes sense
  if the screen is reachable.
- `Organisation.settings.packManaged` is an ownership record, not configuration.
  It stores the exact strings the last pack apply wrote, so a later apply can
  tell "untouched" from "the tenant renamed it". Delete it and industry
  switching silently stops converging. It exists only because `Pipeline` /
  `PipelineStage` have no `packCode` column — see MM2-03.
- `updateOrgSettings` (`backend/src/config/org-settings.ts`) is now the ONLY
  supported way to change `Organisation.settings`. It takes a row lock. Writing
  that column with a plain read-spread-update reintroduces a lost update that
  reports success on both requests.
- Signup no longer writes `settings.featureProfile.enabledNavigation`,
  `crmAiIndustryContext` or `crmQualificationFields`. Navigation is derived from
  the pack on every read; the other two had no readers at all.

**Verification entry points**

    cd backend && TEST_PATTERN='multi-market-phase2|industry-onboarding|tenant-config' node scripts/run-e2e.mjs

`industry-onboarding.e2e-spec.ts` needs no database — it is pure unit coverage of
the packs, the lexicon and the entitlement map, and it runs in ~12s.

**Known blocked (see MM2-01..06 in docs/work-requests/CLAUDE-MULTI-MARKET-PHASE-2-PROMPT.txt)**
Staff login handles are still minted at `eclatdiamonds.in` for every tenant; the
public landing page is still Eclat marketing; `PipelinesService.ensureDefault`
can still pre-empt a pack's funnel if it runs first.
