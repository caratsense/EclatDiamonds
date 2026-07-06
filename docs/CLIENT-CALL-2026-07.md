# Client Discovery Call — Requirements Capture (2026-07-06)

> Source: live walkthrough call with the business owner (Ratanlall jewellery) + dev.
> This is the **authoritative list of the client's real business rules** per module.
> `ACTIVE` = build now · `LATER` = client explicitly deferred · `TBD` = needs more input.
> Where a rule contradicts an earlier assumption, **this doc wins** (it's from the client).

Legend for inputs still needed from client: **⟶ NEED**.

---

## Module 1 — CRM & Lead Management  `ACTIVE` (highest daily use)
When a lead is added by a store manager:
- **Store select** on every lead — so you can see which store the lead belongs to. (Multi-store scoping, already core.)
- **Remarks** free-text field.
- **Lead source** field — **REQUIRED**: `WhatsApp` / `Walk-in` / `Instagram` / (extensible). Purpose: day-end analysis of where leads come from. *Currently missing on the entry form — must add.*
- **NO price / amount field** on the lead. Price is irrelevant to CRM; if needed the manager writes it in **remarks**. (Remove/omit the amount field.)

**Two auto follow-ups (the core ask):**
- **Follow-up 1** date = lead-created date **+ 7 days** (auto-filled).
- **Follow-up 2** date = lead-created date **+ 30 days** (1 month, auto-filled).
- Store manager **can edit** either date per lead (e.g. change 7 days → 3 days) for a custom cadence the customer asked for.
- These are the "SOP" defaults; the edit box gives the custom-date flexibility.

**Reminders — in-app ONLY (this is emphatic):**
- **NOT** WhatsApp to the customer. **NOT** push/pop-up notifications. Owner said WhatsApp auto-messaging becomes "kachra".
- A **Reminders section** on the dashboard/website: when the store manager opens it, they see **today's follow-ups** ("aaj kis-kis se follow-up lena hai").
- Owner/HO can see **all pending follow-ups per day in one place**.
- Reminder is **assigned to the store manager** of that lead's store.
- **Mark-done / approve mechanism**: each follow-up has an approve (tick) action. It stays **pending** until the manager marks it done. On approve, a record/notification is generated **but only visible inside the reminders section** — no pop-up anywhere.

---

## Module 14 — Returns, Exchange & Buyback  `ACTIVE`
For the **store manager**. Customer returns a piece bought earlier (e.g. ~1 yr ago) for **exchange** or **buyback (cash)**.

**Manager enters the ORIGINAL bill details** (manual for now — do NOT auto-fetch from Gati yet):
- Gold: **weight** + **rate at purchase**
- Diamond: **weight** + **rate at purchase** + **specification** (1 ct / 2 ct / 3 ct / 20 cent … or their **internal diamond code**)
- Making charge (at purchase)

**System auto-computes today's value:**
| Component | EXCHANGE | BUYBACK / RETURN (cash) |
|-----------|----------|-------------------------|
| Gold | **100%** of today's gold rate × weight | **100%** of today's gold rate × weight |
| Diamond | **100%** of today's diamond rate × weight (after applicable discount) | **80%** of today's diamond rate (prevailing market value, after discounts) |
| Making | **not returned** | **not returned** |
| GST | **not returned** | **not returned** |

- **Exchange** total is **adjusted against the new purchase bill** (e.g. new bill ₹3L − exchange value).
- **Buyback** is paid out as cash.
- **Rates:** gold = daily (Indian standard, auto). Diamond = **HO-set manually**, changes only every **3–6 months** (not daily). Making example today = **₹1500/g**. **⟶ NEED:** the client's current **diamond rate table** (by spec/code) + making rate.
- Requires **backend (HO) approval** to process the exchange/return.
- Volume is low today (<5 in 2 yrs) but expected to grow with more stores.

### Repairs (a sub-option on the same page)  `LATER / low-priority`
- Accept any product (ours or not — "we accept both").
- **4–5 repair types** (e.g. soldering), each a **fixed charge** (₹500 / 1000 / 2000 …). **⟶ NEED:** the repair-type + charge list.
- Manager: take a **photo** of the piece → upload → pick repair type → **auto short repair bill / receipt** → hand to customer (or WhatsApp).
- Software-receipt integration deferred; owner said "repair me kya hai baad me sochte hain."

---

## Module 15 — Discount Management + Approval Hierarchy  `ACTIVE` (models partly exist)
- **Gold = NO discount, ever.**
- Discount applies to **diamond** and **making**, configurable **area-wise**.
- **Approval hierarchy (2 escalation tiers):**
  1. **Store manager** — owner-set default caps, e.g. **diamond ≤ 5%**, **making ≤ 10%**. Within caps = auto-OK. **⟶ NEED:** confirm exact default caps.
  2. Above caps → **Area / Zone manager** approval (their discretion; varies by customer & order quantity — no fixed minimum).
  3. High (e.g. **diamond 30–40%**) → **Head Office** approval.
- **Cost / margin visibility (important):**
  - **Store manager sees ONLY the selling price.** Never the cost price.
  - **Approver (area mgr / HO) sees cost price + margin** — "margin was X, now Y after this discount" — to decide. Product **cost & selling price come from Gati**.
- Flow: SM requests → area mgr sees costing/selling → approve or reject → if beyond area-mgr limit, escalate to HO → HO approve/reject.
- *Build note:* `DiscountLimit` + `DiscountRequest` models already exist (auto-approve vs escalate). Align them to this exact 2-tier escalation + **hide cost from store_manager role** rule.

---

## Module 2 — Custom Order Booking  `ACTIVE` (replaces a Google Sheet)
~**70% of orders are custom** (new design, or changes to a ready design; straight ready-to-bill is rare). Replace the owner's Google Sheet. **⟶ NEED:** the client will send the actual Google Sheet to the group as reference.

**Fields per order (store manager enters):**
- Customer name
- **Reference image** (upload)
- Product category (e.g. women's ring)
- Quantity
- **Details** (free text — e.g. "instead of red stone → green stone, rest same; ring size 16; diamond weight 1.71")
- **Order placed date**
- **Estimated delivery date** given
- **Advance received**
- **Estimation given** (quoted amount)

**Behaviour:**
- Orders appear in an **ongoing-orders list**, **filterable by store**, with **timeline tracking** (ties to Module 8 internal timeline).
- Back office can view all ongoing orders **store-wise** and track each order's timeline/status.

---

## Sales (Direct Sales) format  `ACTIVE` — feeds reporting
A **separate Sales format** (alongside Orders) for direct sales, primarily for **reporting** (weekly reports to the investor).
- Fields: customer name, product description, **actual bill / invoice number**, **sales value**, **after-discount value**.
- Present as **"Sales & Orders"** sections.

---

## Stock Order / Replenishment  `ACTIVE`
- Store manager can open a **stock order** (new jewellery to be made **for stock / replenishment**) — **same flow as a custom order**.
- It goes to the **back office** as a requirement (e.g. "3 men's rings needed").
- **Fixed timeline = 21 days** (auto-shown) so the back-office team stays systematic.

---

## Module 9 — Inventory / Stock  `ACTIVE (display) — data from Gati`
- **Store-wise** stock view (which store holds what, how much) + all-stores view.
- Data comes **from the Gati server** (Eclat just displays the columns; input reflects from the server). Owner wants to **see it reflected first**, then iterate the UI.

---

## Module 12 — Payment Collection  `ACTIVE — folded into Sales & Orders (no separate module)`
For each order/sale, capture:
- **Advance payment method**: cash / card / UPI.
- Upload **receipt photo** + **quotation photo** (given to customer) + **invoice photo** (if made).
- Track **advance received vs total/complete** amount — for **both** direct sales and order booking.
- This is what feeds all the **MIS reports**. (So no standalone payments screen.)

---

## Module 6 — HRMS & Geo-Tagged Attendance  `ACTIVE`
- Multi-store **geo-tagged check-in** (check-in valid after entering the store's geo-fence).
- **HO can log in from anywhere**; store manager is tied to their store.
- **Week-off / holiday** config per store (set by HO/head office).
- **Shift / batch support:** mall stores run **2 shifts** (morning ~10am, night till ~10pm). A **second-batch** person must **not** be marked "late".
- **Buffer + late rule:** e.g. start 11:00 with a **15-min buffer**. **3× late** (each check-in >15 min after start) → **half-day cut**. **For now: only FLAG** "employee was late 3 times" — do **not** auto-cut salary yet.
- Salary / half-day-cut automation = **LATER**.

### Incentives  `LATER-ish`
- **Store-wise incentive**: e.g. store does ₹20L; first ₹10L no incentive; amount above ₹10L × **1%** → store incentive (₹10,000 in the example). How it's split among staff is separate.
- Monthly sales auto-computed (sales + order booking + payments) → **auto-flag** the incentive.
- **⟶ NEED:** the owner will give the **cap/threshold** per store.

---

## Module 10 — Reporting & DSR  `ACTIVE`
- Daily data → **auto-generate weekly + monthly reports** (roll-up). Replaces the manual "accounts person makes weekly report" step.
- Delivery: **WhatsApp** or **email** (owner's choice). **⟶ NEED:** owner's email ID for the mail format.

---

## Deferred / needs a separate session
- **Module 17 — Gold Savings Scheme** (₹5000 × 11 months, company pays the 12th): `LATER`.
- **Module 17 — "Earn with Ratanlall" referral/commission**: `ACTIVE` — referrer X gets a **coupon code**; referred Y gets **5% off diamond**; X earns **5% commission on Y's total bill**, **redeemable or cash-out**. *Dev safeguard suggested:* **cap** how many people one code can be used by (prevent public leak); owner OK with thinner margin (goal = new customers).
- **Module 5 — Catalogue / AI image search**: `TBD` — depends on syncing the saved designs **with images** from the server; revisit after image integration.
- **Module 11 — New Store Setup**: `LATER` — rough draft only; needs a dedicated ideation session with their team.
- **Module 16 — Marketing**: `TBD` — call cut off before details.

---

## Inputs still needed from client (consolidated ⟶ NEED)
1. **Google Sheet** for custom orders (reference for Module 2 fields).
2. **Diamond rate table** (by spec/internal code) + **making rate** — for Returns/Exchange/Buyback (Module 14).
3. **Repair types + fixed charges** list (Module 14 repairs).
4. Confirm **store-manager default discount caps** (diamond %, making %) (Module 15).
5. **Incentive cap/threshold** per store (Module 6 incentives).
6. Owner's **email ID** for report delivery (Module 10).
