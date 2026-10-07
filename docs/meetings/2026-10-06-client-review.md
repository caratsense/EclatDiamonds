# Client review — 6 October 2026

Decisions from the client meeting, written up as action items. **Nothing here is
built yet except A1, which exists but has to move.** Everything else is
documented for scoping, not started.

Client side: Ayushi (owner), Pratham (head office).

---

## The headline: the DSR runs the wrong way round

Everything else on this page is an improvement. **A5 is a reversal.** The daily
sales report currently flows *staff → WhatsApp bot → dashboard*. The client
wants *staff → dashboard* for filing, and the bot used only to *push the
finished report out to head office*. The staff questionnaire comes out
altogether.

Read A5 before planning any of the others, because it retires a component other
work might otherwise be built on top of.

---

## A1 — Move the bot script into CRM, beside Conversations

**Status: built, in the wrong place.** Branch `feat/bot-script-editable`,
commit `a5593f1`. Not pushed, not on `main`.

**Decision.** The editor exists and works, but it currently sits as a tab under
*Settings → Business Configuration*. It should be **its own item in the CRM
section of the sidebar, directly below Conversations** — named "Bot script" or
similar. It is a thing the client operates day to day, not a setting they
configure once, and burying it three clicks deep under Settings mis-states that.

**Why it matters.** The client asked for it by position, not just by existence:
they expect to find it next to the inbox it affects. Someone rewording the
bot's questions is thinking about conversations, not about configuration.

**Scope.**
- Add a nav entry under the `People` group, after `conversations`, in
  `frontend/src/lib/navigation.ts`.
- Give it its own route and page rather than a tab inside Business
  Configuration.
- Remove the `Bot script` tab from `settings/configuration`.
- Backend needs no change: the endpoints are already
  `GET`/`PUT /crm/qualification/bot-script` and are tenant-scoped.

**What it already does**, and should keep doing after the move: a box per
question for the prompt, its optional smaller line, and each tappable answer
label; blank means "use the built-in wording"; answer labels capped at 24
characters because WhatsApp truncates list rows there; only edited fields are
stored, so untouched questions keep tracking product defaults.

**What it deliberately does not allow**, and should continue not to: changing
the stored `value` behind an answer, or adding/removing answers. Those values
are read back by the branching logic, the free-text parser, lead scoring and the
customer record. A renamed label is harmless; a renamed value breaks branching
and orphans every answer already recorded against the old one.

**Done when** a head-office user finds "Bot script" under Conversations in the
sidebar, can reword a question there, and the next new conversation uses their
wording.

**Open question.** The client described it as setting "what kind of questions
they want to ask and what kind of response against each question". The built
version lets them reword the **questions and the tappable answers**. If
"response" means *what the bot replies after an answer is chosen* — the closing
lines — that is additional scope and is **not** built. Confirm before
estimating.

---

## A2 — Remove the duplicated assignment control from Team

**Decision.** The per-member assignment control on **Settings → Team** is
removed. Assignment lives in **Settings → People & Access** only.

**Why.** The same action is currently reachable from two screens. Two doors to
one setting is how two people end up making contradictory changes, and how a
support call becomes "but I changed it and it didn't stick".

**Scope.** Team's per-row actions today are *Leave quota*, *Change role*,
*Reassign store*, and *Reset password*, plus *Add staff*. The one to remove is
the assignment control — **confirm with the client whether this is "Reassign
store"**, which is the only per-member assignment action on that screen.

Everything else on Team stays. Adding staff, resetting a password and changing a
role are not duplicated anywhere and are the reason a store manager opens the
screen at all.

**Watch for.** People & Access is **head office only**
(`roles: ["head_office"]`), while Team is open to store managers within their
own scope. So removing the control from Team does not relocate it for a store
manager — it **takes it away from them entirely**. That may be exactly the
intent, but it is a permissions change dressed as a tidy-up and the client
should say so out loud before it ships.

**Done when** the control appears on People & Access only, and a store manager
opening Team sees no assignment action against a member.

---

## A3 — LLM-answered conversations, as a paid option

**Document only. Do not build.** Recorded here so it is not lost and not
started by accident.

**Decision.** The bot answering from the client's own configured script stays
the **primary and default** behaviour. Separately, there would be an **option**
to let an LLM generate replies instead. This is a **premium feature** — charged,
opt-in, off by default.

**Why it is framed as an option, not an upgrade.** The scripted bot is
predictable and the client owns every word of it. An LLM is neither. Making it a
deliberate, paid opt-in keeps the default safe and makes the trade explicit to
whoever switches it on.

**Prior art that already exists** and should be reused rather than rebuilt: the
`ConversationAiGate` already enforces three handling states (`human`,
`unassigned`, `ai`), auto-reply is already off by default per tenant and already
requires a configured provider, and the Ad routing screen already exposes a
per-rule **First handler** choice of *AI first* / *Human only*. The mechanism is
largely in place; what this item adds is the commercial gate and the
customisation surface.

**Not scoped.** No estimate, no design, no ticket beyond this note.

---

## A4 — Google Sheets import

**Decision.** There is currently **no way to import from Google Sheets
anywhere** in the product. Add it where it is needed, starting with **customer
data**, and include a **date-range filter (from / to)** so a client can bring in
a slice rather than the whole sheet.

**Why.** Every client arrives with history in a spreadsheet. Today the only
route in is a file upload, which means exporting from Sheets first, and doing it
again every time the sheet changes.

**Scope.**
- Customer data first. Survey the other import surfaces and decide which else
  need it rather than adding it everywhere by default.
- From/to filter on import.
- Decide the connection model: a shared link, or an authorised Google account.
  This is the decision that drives the estimate, and it is not made yet.

**Prior art.** `Settings → Data & Imports` already has *Import a file*, import
history showing "exactly what it did", and **saved column mappings** — map once,
and next month is one click. Google Sheets should become another **source**
feeding that same pipeline, not a parallel one.

**Done when** a client can connect a sheet, pick a date range, map the columns
once, and see the run in the same import history as a file upload.

---

## A5 — Reverse the DSR  ⚠ biggest change

**Decision, in the client's words: the DSR runs the other way round.**

### What happens today
Staff message the DSR bot on WhatsApp. It asks them twenty questions (nine on a
day with no sale). The answers land on the dashboard for head office to read.

### What the client wants
1. **Staff file the DSR in the software.** They open the dashboard, fill in a
   form, and submit. That is the only filing route.
2. **The form keeps the same fields and the same information** as today —
   restructured and laid out properly, and the preview improved. Same data,
   better screen. Nothing is being added to or removed from what is asked.
3. **The staff questionnaire bot is removed.** Staff are no longer asked
   questions over WhatsApp. That flow goes.
4. **The DSR bot becomes outbound only.** Once a day, at a configurable time
   (around 18:00–19:00), it sends **one consolidated message** containing every
   store's figures, in the **same format the dashboard already shows head
   office**.
5. **It goes to head office — Pratham and Ayushi.** They are the people given
   access to the bot. They receive a single daily message with the whole report,
   not one message per store and not a prompt to fill anything in.

### Why this is the right way round
Staff filling a twenty-question form over WhatsApp was always the awkward half.
The people who need the number pushed to them are the ones who are not sitting
in front of the dashboard — head office — and the people who are already in the
software all day are the ones being asked to use a chat window.

### Scope

**Keep and build on:**
- `backend/src/reporting/dsr-sheet.ts` — `DSR_ROWS` and `DSR_SUMMED` are the
  canonical format. **This is the format the daily message must use**, because
  it is the one the dashboard already renders and the client asked for "that
  format".
- `POST /reporting/daily` — filing a DSR from the dashboard **already exists**.
  The work is making it the only route and improving the form around it.
- `dsr-pdf.ts` / `dsr-xlsx.ts` — the renderers.
- `ScheduledReportsService` and its scheduler tick — the existing mechanism for
  "a report that sends itself", and the natural place for a daily job.

**Retire:**
- `backend/src/whatsapp-bot/dsr-flow.ts` (467 lines) — the twenty-field
  questionnaire, its skip logic and its payment-split validation.
- The staff-facing half of
  `backend/src/whatsapp-bot/whatsapp-conversation.service.ts` (561 lines).
- `Settings → WhatsApp Reporting`, which binds a staff handset to a person so
  they can file. With nobody filing over WhatsApp, the screen's purpose goes
  with it.

**Build:**
- A proper DSR form on the dashboard — same fields, better structure, better
  preview.
- A daily scheduled job at a configurable hour, per organisation.
- A consolidated all-stores message in the dashboard's format.
- Recipient management: who receives it. Starts as Pratham and Ayushi.

**Done when** a store files its DSR on the dashboard, nobody is asked anything
over WhatsApp, and at the configured hour head office receives one message
carrying every store's figures in the dashboard's own format.

### Open questions — these need answers before building

1. **Does the number carry over?** The staff reporting line is
   **+91 72089 12616**. It currently receives from staff; it would now send to
   head office. Same number, or a different one?
2. **WhatsApp will require an approved template.** A daily push to head office
   is business-initiated, and outside the 24-hour window only a Meta-approved
   template can be delivered. A full DSR is long and highly variable, which is
   awkward for a template. **This is the single biggest technical risk in A5**
   and should be checked with Meta's template rules before committing to a date.
   A PDF or a link to the dashboard may be the realistic shape.
3. **What happens when a store has not filed by the cut-off?** Omit it, show it
   as missing, or hold the message?
4. **One message for all stores, or one per store?** The client said
   consolidated; confirm that holds as the number of stores grows.
5. **Does anything still need the twenty-field questionnaire** before it is
   deleted — any historical reports that depend on its parsing?

---

## Outstanding from testing — not meeting items, but open

Found while verifying the live site on 5–6 October. Listed here so they are not
lost behind the new work.

| # | Issue | State |
|---|---|---|
| 1 | **Attendance fix is merged to `main` but not deployed.** Railway has not restarted in ~25 hours, so production still lets a punch through without asking for a reason. | Blocked on Railway access |
| 2 | **Live ad greeting is mojibake.** All three creatives store `Ã‰clat`, so anyone tapping an ad is welcomed by corrupted text and gets it pre-filled into their reply. It is in Meta's ad config, not our code. Fixing it needs a new creative, which changes the ad links. | Client to fix in Ads Manager |
| 3 | **Quote approvals is set to "Every quote"**, so no quotation can be sent until a manager approves it. Likely why sending appeared not to work. | Configuration decision |
| 4 | **"Surat" ad set targets Jabalpur**, not Surat. | Configuration |
| 5 | **"Let applicants request the Store Manager role" is switched on**, though it is off by default. | Review |
| 6 | **Authenticated screens are slow.** Business Configuration and Conversations took 45s+ to become interactive in a clean browser; the API health endpoint answers in ~0.5s, so it is the page-data queries, not the server. | Raised with Shreyansh |
| 7 | **`sync@caratsense.in`** — the Gati sync agent — is an active `head_office` account with a password set, sitting in Pending assignment. A machine account does not need a login. | Review |
| 8 | **Lead scoring misses real phrasing.** The signal phrases are literal English ("want to buy", "this week"); customers write "Okay", "haan", "kitna". Genuine leads score 0. | Phrase coverage |
| 9 | **Product renamed to CaratSpace.** The manual uses it; the frontend still says CaratOS everywhere. | Rename pending |

---

## Summary

| # | Item | Build? | Size |
|---|---|---|---|
| A1 | Move bot script into CRM, below Conversations | Built — relocate | Small |
| A2 | Remove duplicated assignment control from Team | Yes | Small |
| A3 | LLM replies as a premium option | **Document only** | — |
| A4 | Google Sheets import, with date range | Yes | Medium |
| A5 | **Reverse the DSR** — dashboard in, bot out to head office | Yes | **Large** |

**Sequence.** A5 first, because it retires components the others might
otherwise be built against. A1 and A2 are small and can go in alongside. A4 is
independent. A3 is not started.
