# Client Notes — Round 2 (diary + 3 voice notes, 2026-07)

> Source: owner's handwritten diary (AI-extracted) + 3 recorded meetings. This
> REFINES and in places OVERRIDES `docs/CLIENT-CALL-2026-07.md` (round 1). Where
> the two disagree, round 2 wins. Tags: `NEW`, `CHANGED`, `SKIP/HOLD`, `LATER`.

## 0. The big architectural picture (read first)
- **Eclat = front-of-house. Gati = billing + inventory engine.** Eclat owns CRM,
  quotation, **custom-order booking**, catalogue, sales-admin. **Actual billing +
  final invoice happen in Gati** (their tag-scan system). Custom orders are created
  in Eclat → confirmed → the team bills them in Gati. Do NOT try to replace Gati's
  billing until every Gati function is rebuilt (later).
- **Data flows FROM Gati into Eclat**: stock, design, pricing, images, final bills,
  payment mode — all fetched/read-only from Gati. Eclat cannot push changes back to Gati.
- **Merge Quotation & Pricing  +  Timeline & Status into ONE module.** On that
  screen the user picks **"Create Quote"** (just a quote) OR **"Custom Order"** (goes
  to back office + shows in the timeline). Same detail form; custom order makes more
  fields mandatory (star-marked), quote makes fewer.
- **"@" Kaccha / rough-estimate mode** (`CHANGED`/`LATER`): typing `@` (or a chosen
  symbol) before an amount = rough estimate → **no GST**, saved to a **separate
  password-protected database** (head-office ID only), never on the main list. Client
  has stopped kaccha for now but wants the provision designed in.

---

## 1. Add Lead / CRM
- Contact details on a lead: **address, birthday, anniversary** — shareable via WhatsApp. `NEW`
- **Birthday auto-offer** (e.g., 50% off making) — keep open-ended; auto WhatsApp. `NEW` *(but see round-2 rule: WhatsApp/automation MANUAL for now — build the hook, don't auto-send yet.)*
- DSR appears automatically after the customer's name. `NEW`
- **Filter by date** (sort latest first). `NEW`
- Date auto-marked whenever the customer visits. `NEW`
- **Do not allow saving a lead without a phone number.** `NEW`
- CRM is currently thin — "needs research (Vedant)". Change the **MIS-type layout**. `CHANGED`
- Reminders module: **"All good"** — round-1 build accepted. ✅

## 2. Quotation & Pricing  (merge with Timeline — see §0)  `CHANGED` (major)
New-quote form fields:
- **Gold**: gold price (auto-fetch OR **manual**), gold weight, gold carat.
- **Diamond**: price (**manual** — sales reads a pricing chart and types it), weight, **type**. Attach a **pricing-chart reference** on screen.
- **Add Diamond ("++")**: multiple diamonds per piece (different carats / many small stones). `NEW`
- **Reference images** / add-photos on the quote. `NEW`
- **GST auto-calculated** on the quote (gold + diamond + making). `NEW`
- Two actions on this screen: **Create Quote** (→ print in a fixed format, send to customer) · **Custom Order** (→ back office + timeline). `NEW`
- **Repairs** as an option here `NEW`: fields = **photo, details, remarks, gross weight**; charge is **making-only** (weight matters, metal value doesn't). Gati doesn't do repairs either — accept any piece. Keep open-ended.

## 3. Custom Order Creation  (routes to back office)  `CHANGED`
- Product attributes: **Ring size**, **Bangle/Bracelet size** (India sizing for now), **Color** (yellow / white / rose gold — open field so platinum/silver can be typed), **Remarks**, **Date of Delivery**. `NEW`
- Conditional form: **custom order → extra fields mandatory**; quote → fewer mandatory.
- Quote/order routes to **Head Office** for approval.
- **GST auto-calculated** (diamond + gold + making + other costs).
- **Advance**: amount received, **mode of payment**, **receipt photo** (feeds finance/DSR). `NEW`
- **"@" kaccha**: no GST, separate password-protected DB (§0).
- Custom order is **pushed into the merged Timeline view**.

## 4. Timeline & Catalogue
### Timeline `CHANGED`
- Add the missing **categorization**. Merge with Quotation (§0).
### Catalogue `CHANGED` (mostly LATER — needs Gati image/back-end connection, ~2-3 days)
- **LLM product descriptions** (auto info about each product). `NEW`
- **Copy / archive of past designs** — keep old (already-sold, un-replenished) designs visible in the catalogue via a copied "archive" instance. `NEW`
- **Bulk upload via Excel** — e.g. 50-100 designs the salesperson can show even if not in stock. `NEW`
- **Search + tag filters**: Rings / Earrings / Bangles; **in-stock vs buy-order**. `NEW`
- **Gati link**: pull design + pricing + images (size-wise) from Gati automatically; if not in Gati stock, still show here as buy-to-order. Eclat is "one source of extraction" from Gati.
- **Photo search** — upload an image → closest matches. 3 modes: (a) image → matches, (b) show "what we can make" list, (c) describe attributes → filtered results.
- All-stores designs visible from any store (reads the overall Gati DB). No per-store store-locator.

## 5. Returns & Discounts
### Returns `CHANGED`
- **Invoice number auto-extracted from Gati.** `NEW`
- Second option **"PUT MANUALLY"** (per the shared Excel). Toggle **"By Invoice"** vs **"By Manual"**. `NEW`
- Gold + diamond price **auto-fetch, with a manual override**. `NEW`
- **"Submit for Approval"** → sends the transaction to head office. `NEW`
### Discounts
- **To be discussed / changed later.** `LATER`

## 6. Loyalty & Referral
- Keep open-ended. Scheme details sent to the customer in **Excel format**, automatically (for now). `NEW`
- **Referral wallet** `NEW`: each referrer → a **referral code**; track per referral **date, invoice no., bill amount**; **total wallet = earned − redeemed**; show **redeemed** + **wallet balance**. Shareable to the customer as a **WhatsApp PDF**. Manual send for now (automate later). Framework must be dead-simple.
- WhatsApp Business account / dedicated Eclat number needed for automation — **later** (manual now).

## 7. Inventory, Payments, Finance, HRMS
### Inventory & Stock  `CHANGED` (import pending)
- Read-only from **Gati**, **store-wise**. Salesperson doesn't see it; **Area Manager + Head Office do** — for "what's selling / what's not" analysis. Import into cloud still pending.
### Payments  `CHANGED` (remove the standalone tab)
- **Remove the Payments tab** — payment method flows automatically from Gati.
- **Reconciliation is the real priority** (do with the CA): card payments hit the bank **minus ~1.1%**, and banks **batch a day's transactions into one payout** → manual reconciliation is painful. Build toward auto-reconciliation.
- **Merge custom-order advance (Eclat) + final billing (Gati)** so the balance (e.g. ₹3L bill − ₹2L advance = ₹1L) shows in one place.
- **Proof of payment**: card → uploaded photo; **cash → store-manager-signed slip photo**. `NEW`
### Finance & Fund Planning — `TBD with CA`  `LATER`
### HRMS & Attendance — `SKIP for now`
- **Skip the whole HRMS module currently.** Revisit after researching **Zoho** (and other established CRM/HRM platforms) for best practices.
- Attendance: **phone login + geofencing** (auto check-in within 50–100 m of the store) — NOT face-scan (separate software). Owner's alt idea: one in-store phone with a face-scan app (open-source) — to explore.
- Policy: **1 week-off per week for all staff**.
- **Commission** strictly from **sales data**; **rate editable**. Currently not editable — make it so.
- **Leaderboard/Commission belong under Sales, not HRMS** (owner questioned the placement). Leaderboard auto-computed from each salesperson's quotes/sales (+ Gati). Low value for 3-4-person stores, but build it.
- **Check-in & footfall → integrate with CRM** (not a separate module).

## 8. Ticketing  `CHANGED`
- Add **remarks + situation notes**. `NEW`
- **Remove "category"** — tickets go straight to the **back office** to be prioritised. `CHANGED`
- Track **"who raised"** the ticket. `NEW`
- **Close** action specifically on the **back-office** interface. `NEW`

## 9. New-Store Setup & Marketing — `ON HOLD`

---

## Cross-cutting rules (apply everywhere)
1. **Gati is read-only source of truth** for stock/design/price/image/final-bill; Eclat reads, never writes back.
2. **Manual-first**: diamond price, referral-wallet share, WhatsApp/offer sends — all MANUAL now; automation hooks built for later.
3. **"@" = kaccha** → no GST, separate password-protected DB (head-office only).
4. **Approvals** (custom order, discount, return) route to **Head Office**.
5. **Proof-of-payment attachments** (card photo / cash-slip photo) are mandatory for reconciliation.

## Inputs still needed from client
1. Diamond **pricing chart** (for the manual entry reference).
2. Ring / bangle **size lists** (India).
3. ~~The shared **Excel** for returns (manual layout) + the referral-wallet sample.~~ **RECEIVED** → see §A below (`EXchange Buyback Sample.xlsx`, `Referral Program.xlsx`).
4. Repair **charge list** (making-based).
5. CA session for **reconciliation + finance** design.
6. Gati **back-end access / field walkthrough** (to build the Gati→Eclat extraction fully).

---

## §A. Exchange / Buyback spec  (`EXchange Buyback Sample.xlsx`)  `NEW` — extends Returns/M14
A single old piece is valued three ways. Example piece: 18kt gold 14.11 g, diamonds 3 ct, making 14.11 g.

**Common component structure** (each of the 3 blocks): `RM | Wt | Rate | Discount% | Rate-after-disc | Total | ValueGiven× | Final`.
- **RM rows** = `18kt Gold`, `Diamonds`, `Making` (metal / stones / labour).
- **Rate-after-disc** = Rate × (1 − Discount%). Diamond discount carries over from the old bill (e.g. 21.43%).
- **Total** = Wt × Rate-after-disc.
- **ValueGiven×** = how much of that component the customer gets back (a 0–1 multiplier). **Final = Total × ValueGiven×.**

**1. Old Bill** (reference only — what the customer originally paid):
| RM | Wt | Rate | Disc | After | Total |
|----|----|------|------|-------|-------|
| 18kt Gold | 14.11 | 5244 | — | 5244 | 73,992.84 |
| Diamonds | 3 | 70000 | 21.43% | 55000 | 165,000 |
| Making | 14.11 | 750 | — | 750 | 10,582.50 |
| **Total** | | | | | **249,575.34** + 3% GST 7,487.26 = **257,062.60** |

**2. Exchange** (trade old piece toward a NEW purchase → most generous):
- Gold priced at **current market rate** (12,050, not old 5,244), **ValueGiven = 1 (100%)**.
- Diamond at current rate 34,000 − 21.43% = 26,714.29, **ValueGiven = 1 (100%)**.
- Making **ValueGiven = 0 (0%)** — labour never returned.
- Final exchange value = 170,025.50 + 80,142.86 + 0 = **250,168.36** (GST line = 0 — exchange value carries **no GST**).

**3. Buyback** (sell old piece back for CASH → diamond penalised):
- Gold same as exchange, **ValueGiven = 1 (100%)**.
- Diamond **ValueGiven = 0.8 (80%)** → 80,142.86 × 0.8 = 64,114.29.
- Making **ValueGiven = 0**.
- Final buyback value = 170,025.50 + 64,114.29 + 0 = **234,139.79**.

**Rules distilled:** metal always at *current* rate @100%; making @0% always; diamond @100% for exchange, @80% for buyback (the buyback multiplier is the one configurable knob — store in config). Exchange/buyback amount is a credit, **no GST on the returned value**. Flow: look up old bill (from Gati later, manual now) → enter current rates → pick Exchange or Buyback → **submit for approval** to Head Office.

## §B. Referral program spec  (`Referral Program.xlsx`)  `NEW` — refines §6 / M17
- **Person A** = Marketing Associate (referrer, has a referral code). **Person B** = new customer.
- **Person B benefit:** 5% off on **all diamond items** on their bill.
- **Person A credit:** **5% of Person B's pre-GST subtotal** — computed *after* the diamond discount, *before* GST. Credited to A's wallet, redeemable in-store or encashable.
- **Worked example:** gold 30,000 + diamond 60,000 + making 10,000 = 100,000. Person B diamond disc 5% = 3,000 → subtotal 97,000 → GST 2,910 → **B pays 99,910**. **A wallet credit = 5% × 97,000 = 4,850.**

**Wallet data shape (build to this):**
- Associate: `Referrer name, Number, Referral code, Total wallet (Σ credits), Redeemed (Σ encash+redeem), Wallet balance (= total − redeemed)`.
- **Referrals** rows: `Customer name, Date, Invoice No, Bill amount (pre-GST, post-disc)`. Wallet credit for the associate = 5% × Σ(bill amounts). *(Sample: 203,659 + 399,050 + 592,391 = 1,195,100 → 5% = 59,755 = Total wallet ✓.)*
- **Redeemed** rows: `Type (Encash | Redeem), Date, Invoice No (blank for encash), Amount`. *(Sample: Encash 20,000 + Redeem 31,400 = 51,400 → balance 59,755 − 51,400 = 8,355 ✓.)*
- Shareable to the customer as a **WhatsApp PDF** (manual send now).

**T&C to surface in UI (from the sheet):** 18+ MAs only · code shown *before* bill (no retroactive) · Person B must be a genuinely-new customer (PAN/Aadhaar verified) · no same-address family referrals · not combinable with other offers · credits valid 24 months from last activity · credited only once the sale completes · forfeiture on fraud/termination · disputes within 15 days.
