# Previous meeting notes — reconciliation and the small-changes list

7 October 2026. Two inputs: the transcript extract from the previous client
meeting, and today's dictated list of small changes plus the New Customer Data
Google Form. Each item below is mapped to the code before anything is built.

## From the meeting notes — already done vs. left

| Ref | Item | Status |
|---|---|---|
| 00:36–00:39 | Store managers approve salesperson requests but get no global configuration | **Already enforced.** Approvals grant only roles below the approver's rank (`assignableRoles`), so a manager can approve a salesperson and cannot mint a manager. Business Configuration and People & Access carry `roles: ["head_office"]`. |
| 00:38–00:39 | One unified admin page for roles and permissions, not two sections | **Done yesterday** (commit `1521362`): Change role and Reassign store moved off Team onto People & Access, which now holds role, store and per-screen access on one page. |
| 00:40–00:41 | Broadcasting: head office sends instant announcements to all store dashboards | **To build** — item M2 below. |
| 00:47:33 | Log out via the HO chip, top right | **Exists**: user menu → Sign out. Nothing to change unless the ask was something else. |
| 00:47:50 | Why is "the map" rendering at the bottom of the page | **Cannot reproduce from the notes alone** — no map component exists in the frontend (no leaflet/mapbox/embed anywhere in `src`). Needs the page name or a screenshot; parked. |
| 00:48–00:49 | Domain cannot be changed in place; redeploy to a clean target | Infrastructure, not code. Belongs with the Railway/Vercel work; parked with the deploy blocker. |
| 00:58–01:01 | Clone the repo; a second developer takes the generic product, Eclat work continues here | Organisational decision; no code action here. The industry-pack split (CORE_NAVIGATION vs Eclat packs) is already the seam a clone would cut along. |
| 01:07–01:13 | LLM usage billed per tenant with token limits; don't confuse WhatsApp charges with LLM tokens | Documented with action item **A3** (LLM replies as a premium option, 6 Oct notes). Token budgets per tenant are part of that scope. Not built, deliberately. |

## Today's small changes — mapped to code

### S1 — Add a sign-up button to the login screen
The sign-up side exists but is reachable only by `?start=join` / `?start=create`
links (`app/login/page.tsx` — "The sign-in screen has no way into sign-up").
The client now wants a visible way in. **Change:** a "New here? Request an
account" link under the sign-in form that switches `mode` to `signup`
(`signupKind: "join"`). The request still lands in Team → Account requests for
approval; nothing about the approval flow changes.

### S2 — Gold rate: why it is not updating, and hide the number behind a button
Two separate things.

**Why it goes stale:** `GOLD_RATE_SOURCE=gati` means the rate is the shop's own
Daily Rate pushed by the on-site Gati sync agent; the hourly IBJA refresh is
deliberately disabled in that mode so a market pull cannot overwrite the shop's
price (`gold-rate.service.ts`). So "not updating" = the Gati sync has not
delivered today's rate. That is an ops fact, not a code bug — the chip and the
rates page already mark the rate stale with its date. Any fix is on the sync
agent side, recorded here rather than papered over.

**The chip** (`components/layout/gold-rate-chip.tsx`) currently shows
`₹13,639 /g 22K` permanently in the top bar. **Change:** show a neutral
"Gold rate" button; the figure appears in the existing dialog on click. The
stale/fresh dot stays on the button so a stale rate is still visible at a
glance without the number being public to every passer-by.

### S3 — Remove the Custom Order footer button; keep the drop-down route
`quote-builder.tsx` has a "Custom-order details" disclosure (the drop-down,
line ~822) AND a gold "Custom Order" footer button that opens it and then
submits. **Change:** the footer button renders only while the disclosure is
open — closed, the footer carries only the save button; open the drop-down and
"Create Custom Order" appears beside it. The capability is unchanged; the
always-on button goes.

### S4 — Item-code placeholder says "Scan" but there is no scanner
The only such placeholder is the Log walk-in dialog
(`app/(app)/checkins/page.tsx:591` — "Scan or type the code"). **Change:**
"Type the item code".

### S5 — "Create Quote" → "Save Quote"
`quote-builder.tsx:904`. Label change only; the Ctrl+Enter hint already says
"save".

### S6 — Walk-in capture matching the New Customer Data form
The Google Form's fields, mapped onto what exists:

| Form field | Where it lands |
|---|---|
| Store Location | Already implicit — the dialog files against the active store |
| Customer Name, Mobile | Already fields on the dialog |
| Type of Customer (New/Existing) | `metadata.customerType` |
| Birthday, Anniversary | Party record (same fields CRM's Add lead writes) + metadata echo |
| Sales Person Name | Already `attendedBy` (the signed-in rep) |
| Source (10 options + Other) | `metadata.source` / `metadata.sourceOther` |
| Purpose of Visit (5 + Other) | Existing `purpose` vocabulary + `metadata.purposeOther` |
| Purchase Occasion | `metadata.occasion` |
| Product Category (6 + Other) | `metadata.productCategory` / `metadata.productCategoryOther` |
| Budget Range (<50k … >20L, NA) | `metadata.budgetRange` |
| Reason for Non-Purchase | `metadata.nonPurchaseReason` |
| Sales Person Recommended Action (needed from HQ) | Existing `preferredAction` column |
| Saving Scheme Enrolled (Y/N) | `metadata.savingScheme` |
| Reason if not Enrolled | `metadata.savingSchemeReason` |

No migration: `CheckIn.metadata Json` exists precisely for tenant-defined visit
fields ("a jeweller's counter and occasion… lives here instead of in new
columns"). The dialog gains a "Customer details" section with these fields;
the backend DTO accepts and stores them; birthday/anniversary also update the
customer record so CRM occasion prompts fire from them.

### M2 — Head-office broadcast
New: head office composes an announcement (title + body) and every active user
in the organisation gets it in their notification bell, instantly — the bell
already streams (`/notifications/stream`), so delivery to open dashboards is
immediate. Endpoint `POST /notifications/announce` (head office only), audited;
UI on Dashboards for head office. Deliberately the bell rather than a new
banner system: one notification surface, already on every screen.

## Order of work
S4 + S5 + S3 (one pass over the quote builder and check-ins), S2b chip, S1
login, M2 broadcast, S6 walk-in form. S2a documented above; M4 (map) parked
pending a page name.
