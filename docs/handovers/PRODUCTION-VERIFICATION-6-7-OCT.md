# Production verification — the 6–7 October changes

Every change on PR #37 (`feat/bot-script-editable`, 22 commits over `main`),
with the exact steps to verify each one **in production with real data**, and
the path that gets it there. Written to be the reference when memory of the
sessions is gone: if a question starts "did we…" or "how do I check…", the
answer should be on this page.

Production dashboard: `https://eclat-diamonds-pi.vercel.app`
Production backend: the Railway service answering that site's `/_api/*`
(currently the service named `backend-staging-e5cd` — **the name lies, it IS
production**; see "Getting it live", step 0).

---

## Part 1 — Getting it live

0. **Do not delete the Railway service named `backend-staging-e5cd`.** The live
   site proxies every API call to it (verified by matching `/_api/health`
   uptimes). The service named `backend-production-89dd` is a parallel second
   backend the Gati runbooks point at; `eclat-inference` is the catalogue
   photo-search ML service. Consolidation order: back up `89dd`'s database →
   delete `89dd` → check `ML_INFERENCE_URL` on the keeper before touching
   `eclat-inference` → optionally rename the keeper to `backend-production`
   (the generated domain survives a rename).
1. **Merge PR #37** into `main`.
2. **Unstick the deploy.** Railway has not auto-deployed since 5 Oct — the
   backend's uptime just keeps climbing. Check the service for a paused
   deployment, auto-deploy switched off, or the past-due subscription. Nothing
   below is checkable until a deploy carries commit `ad6b726` or later.
   Quick test for whether a deploy happened:
   `curl https://eclat-diamonds-pi.vercel.app/_api/health` — uptime should be
   minutes, not days.
3. **Vercel redeploys the frontend on merge** (it builds from `main`). If a
   change below is "not visible", hard-refresh first — the old client bundle
   carries the old navigation.
4. **Post-deploy configuration (one-time, by hand):**
   - Flip the gold rate to the third-party feed: on the backend service's
     Variables, **delete `GOLD_RATE_SOURCE`** (it currently says `gati`). The
     hourly cron then pulls the IBJA benchmark. Confirm `SCHEDULER_ENABLED`
     is not `false`.
   - Re-enter the **bot script** wording on production `/bot-script` (local
     saves do not travel with code).
   - Configure the **evening digest** on `/reporting`: hour (19 = 7 PM),
     recipients Pratham and Ayushi, toggle On.
   - Have Pratham and Ayushi each **send one WhatsApp message to the staff
     line (+91 72089 12616)** so the 24-hour customer-care window is open for
     the first digest delivery.
   - Create the two **head-office accounts** from Settings → Team → Add staff
     (now possible — see §13).

---

## Part 2 — Each change, and how to verify it in production

### 1. Bot script — the client rewords the customer bot
**What changed:** the four qualifying questions, their hints, the tappable
answer labels and the two opening lines are tenant-editable. New sidebar item
**Bot Script** under Conversations (`/bot-script`). Wording only — the stored
answer values (branching, parsing, scoring) are not editable, answer labels cap
at 24 chars (WhatsApp truncates list rows), blank = built-in default, overrides
are sparse so untouched questions keep tracking product wording.
**Verify:** sign in as head office → Bot Script → reword question 1 → Save.
From a phone that has **never** messaged the business, text anything to
+91 72080 17690 (or tap the live ad). The greeting and question 1 arrive in the
saved wording. A store manager sees the page read-only in effect (Save is
refused by the API); a salesperson doesn't get the page.
**Gotchas:** a conversation already mid-script keeps its old wording (by
design); a number the bot already handed to a human gets silence (also by
design — test from a fresh number).

### 2. Role & store moved to People & Access; People & Access moved to Team
**What changed:** Team's row menu lost **Change role** and **Reassign store**;
both are header buttons on People & Access when a person is selected. People &
Access now sits in the **Team** sidebar group, not Setup.
**Verify:** Settings → Team → any row's ⋯ menu shows only Leave quota, Reset
password, Deactivate. Settings → People & Access (under TEAM in the sidebar) →
pick a person → "Change role" and "Reassign store" buttons top-right. As a
store manager, People & Access is absent entirely (head-office-only).

### 3. DSR reversed — dashboard in, bot out
**What changed:** staff file the DSR on the dashboard only (`/reporting` →
Today's DSR). The WhatsApp questionnaire is retired: texting "dsr" / "1" to the
staff line gets a pointer to the dashboard; a session caught mid-questionnaire
is reset with the same message; no bot path can create a DailyReport row.
**Verify:** from a bound staff phone, text "dsr" to +91 72089 12616 — expect
"Daily reports are filed on the *dashboard* now…". File a DSR on the dashboard
as a manager — expect it under Reporting. Confirm no new report appears from
any WhatsApp interaction.

### 4. Evening digest to head office
**What changed:** once a day, after a configurable store-local hour (default
19:00, swept every 15 min), ONE consolidated WhatsApp message with every
store's figures — footfall, counter sale, bookings per store, **unfiled stores
named**, all-stores totals — to recipients managed on `/reporting` (head-office
card "Evening digest to head office", with Send now for testing). Sent from the
staff line. Once-per-day guard stamps before sending, so a partial failure
can't double-send.
**Verify:** configure recipients + hour, press **Send now** — recipients get
the message (requires their 24-hour window open, i.e. they messaged the line
once). Then leave it: next evening at the configured hour the message arrives
unattended. In local testing the scheduler fired unattended two days running.
**Gotcha:** `delivered: false` per recipient in the Send-now toast means the
24-hour window is closed for that person — have them text the line once.

### 5. Attendance: Skip removed, reason always, third strike flags HO
**What changed:** "Skip for now" is gone from `/check-in` — attendance is
recorded every day. Inside the fence: automatic check-in. Outside / no GPS fix /
vague fix / fence unreadable: "Continue with reason" (every face has it — the
locating-forever dead end is fixed). Every unverified punch still notifies the
branch manager + head office. **New:** the third unverified check-in in a
store-local calendar month sends head office a high-priority
"Flagged: NAME — N off-site check-ins this month", head office only, max once
per day per person.
**Verify:** on a phone away from the branch, check in — it demands a reason,
accepts, and the manager + HO bells ring. Repeat on three days (or check a
habitual offender) — HO gets the Flagged notification naming the count. Confirm
no Skip button exists on any face of `/check-in`.

### 6. Head-office broadcast
**What changed:** Dashboards (head office only) has an **Announce** button:
heading + optional detail → every active person's notification bell,
immediately (the bell streams over SSE), audited under the sender.
**Verify:** as HO, Dashboards → Announce → send. A signed-in manager's bell
shows it within seconds without refresh. Audit Log shows
`notifications.announcement_sent` with the recipient count.

### 7. Walk-in survey (the New Customer Data form)
**What changed:** the Log walk-in dialog (`/checkins`) carries the client's
Google Form: type of customer, birthday, anniversary, source (10 options +
Other), purchase occasion, product category (+ Other), budget range, reason for
non-purchase, saving-scheme enrolled + reason. All optional. Answers live on the
visit (`CheckIn.metadata`, no migration); birthday/anniversary are written to
the **customer record**, where occasion reminders read them.
**Verify:** log a walk-in with the survey filled → open the customer in
Customers → birthday/anniversary show on their profile. Export walk-ins to
Excel (§8) → the survey columns carry the answers.

### 8. Excel exports wherever data is collected
**What changed:** download buttons producing real .xlsx —
`/checkins` → walk-ins.xlsx (survey columns included);
`/customers` → customers.xlsx (birthday/anniversary, archived excluded);
`/quotation` → quotations.xlsx (ref, date, customer, store, status,
salesperson, grand total; **kaccha estimates never export, even for HO**).
DSR sheet (xlsx/pdf) and CRM lead export already existed.
**Verify:** press each button signed in as HO — a valid Excel file downloads,
row count in the toast. As a salesperson, the walk-ins/quotes files contain
only their own rows (scope mirrors the screen).

### 9. Gold rate: sidebar, on-click, third-party feed
**What changed:** the rate chip moved from the top bar to the **sidebar rail**
above "CaratOS Platform"; it reads "Gold rate" with a fresh/stale dot and shows
the figures only in the dialog on click. Quotes **already auto-price** from the
live rate per karat (`quote-builder` reads it; nobody types the gold rate).
**Verify:** top bar has no rate; sidebar bottom has the chip; click → all
karats. After the `GOLD_RATE_SOURCE` env flip (Part 1 §4): Settings → Gold Rate
shows source IBJA with **today's** date, and the chip's dot is green. Create a
quote with a gold line — the rate column is pre-filled with today's per-gram
figure for the chosen karat.

### 10. WhatsApp Reporting screen retired
**What changed:** `settings/dsr-access` removed from sidebar, pack
entitlements and role defaults — it existed to bind handsets for WhatsApp DSR
filing, which no longer exists. (Identity bindings themselves remain; the
staff line still only answers bound numbers for message-to-HO.)
**Verify:** no "WhatsApp Reporting" anywhere in Settings; typing the URL gets
the not-in-your-plan screen.

### 11. Sign-up door on the login screen
**What changed:** "New here? Request an account" under the sign-in form (it
was reachable only by a secret `?start=join` link). Still approval-gated: the
request lands on Team → Account requests; nobody signs in until approved.
**Verify:** log out → the link is under the form → submitting a request shows
"Request sent" and does NOT log in → it appears under Team → Account requests
for approval.

### 12. Quote builder tidy-up
**What changed:** footer button says **Save Quote**; the gold **Custom Order**
button appears only while the Custom-order details drop-down is open; the
walk-in item-code placeholder no longer says "Scan" (no scanner exists). Also:
the Today's-DSR preview on `/reporting` is **head-office-only and
preview-only** — the type-any-number WhatsApp send is gone.
**Verify:** `/quotation/new` footer shows Save Quote alone until the
Custom-order details section is opened; `/checkins` item code reads "Type the
item code"; as a manager, `/reporting` has no Today's-DSR preview button.

### 13. Head office can create head-office accounts
**What changed:** Add staff / Change role offer **Head Office** to head-office
users (for Pratham's and Ayushi's logins). Asymmetric on purpose: HO may MINT
an equal but still cannot manage one — no demoting, deactivating or
password-resetting another HO from the UI. Anyone below HO attempting it gets
403 "Only head office can create a head office account".
**Verify:** as HO, Add staff with role Head Office succeeds and shows the
minted Login ID once. As a store manager, Head Office is not in their role
list (and the API refuses it).

### 14. Earlier but in this same PR: the attendance fail-open fix
**What changed (5 Oct, commit b928b45):** a failed geofence lookup (e.g. the
"all stores" aggregate) used to read as "no fence" and wave punches through
silently. The server now resolves a real store, and the client treats an
unreadable fence as "ask for a reason", never "allow".
**Verify:** with location off entirely, check-in still demands a reason rather
than passing silently.

---

## Pre-existing issues this PR does NOT fix (so nobody re-reports them)

- Quote e2e suites fail identically on origin/main — environmental.
- access-control spec: managers hold `campaigns` though the spec says no.
- The operations manual still documents the retired WhatsApp questionnaire —
  rewrite scheduled after this deploys.
- Live ad creatives greet customers as "Ã‰clat" (mojibake) — fix is a new
  creative in Meta Ads Manager, outside this codebase.
- `sync@caratsense.in` is an active head-office login for a machine account.
