# Client meeting 2 — 7 October 2026, action items

Nine items from the follow-up meeting, each mapped to the code before work
starts. Target from the meeting: the smaller store-side changes by **8 October
afternoon**; DSR UI/UX and the quotation WhatsApp button timing to be
confirmed; the bot work gets 1–3 further days behind the sales module.

Priority order used here (the meeting's own): sales module first (items 1, 2,
5), then RBAC (4), then the bot (7). Items 3, 6, 8, 9 are mostly done,
clarifications, or ops.

---

## 1. DSR booking carry-forward — BUILD

**Ask.** Day 1's **closing** booking amount automatically becomes Day 2's
**opening** booking amount, every consecutive day — nobody looks up yesterday's
report to type a number. The calculation stays:
`closing = opening + new − completed`.

**Code mapping.** `DailyReport` carries `bookingsNew`, `bookingsOpen`,
`bookingsClosed`; the sheet already derives `bookingsClosing`. Today the form
asks for opening bookings as a blank field.

**Plan.** The backend computes the previous report's closing
(`bookingsOpen + bookingsNew − bookingsClosed` of the latest report before the
filing date, per store) and (a) exposes it so the form can prefill the opening
field — shown, editable, labelled as carried forward — and (b) defaults the
value server-side when the client omits it, so the chain holds even for a
filing that skips the field. The value stays editable: the first-ever report,
or a correction after an audit, must not fight the automation.

## 2. DSR UI/UX — BUILD

**Ask.** The DSR screens feel cluttered: improve layout, field grouping,
sequence, navigation across creation, generation and the reporting section.

**Plan.** Restructure the filing form into the sheet's own four groups —
Footfall → Table A (counter sale) → Table B (customised sale) → Remark — with
each payment split visually inside its table, the carry-forward opening shown
as context rather than a question, and a live closing-bookings figure computed
as the person types. Report generation and section layout tidied in the same
pass.

## 3. DSR delivery to head office — DONE, client to test

Multiple WhatsApp recipients, Send now, and the remarks column all shipped in
PR #37 and are live. The one operational step: each recipient texts the staff
line once so their 24-hour window is open (verified today — a fresh recipient
shows "sent to 0 of 1" until they do).

## 4. RBAC — ON/OFF only, Area Manager returns — BUILD (then reconfirm)

**Asks.**
- Per-screen permissions become **ON/OFF only**; Own/Store disappears from the
  controls.
- An **Area Manager** role handling **4–5 assigned stores**, with store
  assignment support.
- Custom role names.
- Attendance access: salesperson/manager → their own; area manager → their
  stores; HR → all stores.

**Code mapping.** `AccessLevel` is `'own' | 'store'` server-side;
People & Access renders a three-way (Off/Own/Store). `area_manager` exists in
the rank ladder but is retired ("nobody can be given them"); multi-store
membership already exists in the data model (`userStores` is many-to-many —
the UI just never assigns more than one).

**Plan.**
- UI becomes a two-state toggle. OFF = `none`. ON grants the screen at the
  role's natural depth (store-manager rank and above → `store`, below →
  `own`), so the server model is untouched and the depth question moves from
  every checkbox to the role itself — which is what the client's attendance
  table actually describes.
- Revive `area_manager`: assignable by head office (Add staff / Change role),
  and a store-assignment control that holds **multiple** stores for that role.
  Their scope across screens follows their assigned stores, which the scoping
  layer already honours (`storeIds` is plural everywhere).
- **Custom role names**: documented, not built — the clean home is the
  Vocabulary tab (per-tenant labels over fixed role keys). Needs client
  confirmation of exactly which names; flagged for the reconfirmation the
  meeting itself asked for.
- **"HR" role**: no such role exists. Nearest truths today: head office sees
  all attendance; or one person can be granted HRMS ON. A true HR role (all
  stores, attendance only) is a new role key — raised for the reconfirmation
  rather than invented unilaterally.

## 5. Quotation — Send to WhatsApp — BUILD (default answered, flagged)

**Ask.** A Send-to-WhatsApp button in the quotation flow, sending to the
number supplied by whoever creates the quote. The meeting left open which
number/source and whether it is editable before sending.

**Code mapping.** The quote list already has a per-row WhatsApp send
(`POST /quotes/:id/share`), gated by Quote approvals ("Every quote" blocks
sending until approved — currently ON in production). The builder itself has
no send.

**Plan.** After **Save Quote** succeeds in the builder, a send step offers the
quote's own customer number **prefilled and editable** — that answers the open
question with the sensible default while keeping the choice. Approval gating
is respected: a quote awaiting approval says so instead of sending.

## 6. Walk-in form — DONE, client + Hitesh to test

Fields, store list and the survey shipped in PR #37 and are live.

## 7. WhatsApp bot — natural typing, campaign content, greeting switch — PART BUILD

**Asks.** (a) Customers type naturally and get the right answer or catalogue
link. (b) For Meta ad enquiries, recognise the campaign/product and send its
pricing; a place to configure campaign links, CTAs, pricing, follow-ups.
(c) ON/OFF for the opening greeting. 1–3 days allowed, after the sales module.

**Plan, split honestly.**
- **Greeting ON/OFF** — small; goes on the Bot Script page and into the
  greeting path. Built in this round.
- **Campaign content** — a per-ad configuration (link, price line, CTA,
  follow-up link) that the bot sends when a tap's referral matches; needs its
  own config surface beside Ad routing. Built next, within the allotted days.
- **Natural-language understanding** — this is the LLM path recorded as action
  item A3 (premium, off by default, per-tenant token budgets). The existing
  bot already accepts answers in words via synonyms; true free-form
  understanding is not buildable responsibly in the allotted window and is
  explicitly flagged rather than faked.

## 8. Employee accounts — mostly answers, one pending

- Imported employees: client reviews and resets passwords before sharing.
- **Deactivate vs delete — answered from the code:** the Team action
  *deactivates* (with lead/walk-in hand-off); nothing deletes the account or
  its history. The row stays, marked inactive, and can be reactivated.
- **Edit employee details** — pending the client's confirmation; today name,
  phone and personal email are fixed after creation (role, store, password and
  access are all changeable).

## 9. Trial rollout and data protection — OPS

One-week trial with store managers, then office staff for attendance. Before
operational data entry: finish the agreed changes, take a database backup
(Railway → Postgres → create backup; repeat before each deploy during the
trial). All schema changes in this period are additive (the walk-in survey
deliberately used the existing metadata column), so updates preserve records.
