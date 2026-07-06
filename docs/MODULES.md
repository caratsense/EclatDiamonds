# Eclat / CaratSense — Module Specification

Consolidated from `Eclat_feature planning.xlsx`, `Jewel Modules - Google Sheets.pdf`, and `Eclat_RequirementsNotes_CaratSense.pdf`. 17 modules. Status legend: ✅ in scope · ⚠️ open point · ❌ dropped.

---

## 1. CRM & Lead Management ✅
**Purpose:** Single source of truth for all potential customers — consolidates inquiries from storefronts, walk-ins, phone, social media, and the website.
- Omnichannel lead capture (website forms, store walk-in tablets, phone logs, digital sources)
- Centralized unified customer profile (history, preferences, interactions)
- Lead-to-order pipeline: Inquiry → Quotation → Order Placed
- Follow-up management: remarks, notes, task reminders for reps
- Multi-level views: store manager (store pipeline), salesperson (own leads), executive (all stores)
- Automated occasion reminders (birthday/anniversary) via SMS/WhatsApp + rep dashboard flag

## 2. Quotation & Pricing Integration ✅
**Purpose:** Pricing consistency across digital and physical touchpoints; easy quote sharing.
- Unified pricing engine synced real-time across WhatsApp catalogues, e-commerce, in-store billing
- Centralized quotation DB — a quote made at one store is retrievable/editable/checkout-able at any branch
- Single-quote portability (quote at Store A → purchase at Store B, same record)
- One-click WhatsApp share of quotes and catalogues
- *Open:* pricing source of truth (gold rate feed, making charges) — see DECISIONS.md

## 3. Departmental Dashboards & Collaboration ✅
**Purpose:** Communication and task tracking between storefronts, back office, and management.
- Role-specific dashboards (Marketing, Finance, Sales, Production)
- Consolidated calendar + to-do lists (meetings, events, deadlines)
- Meeting summaries: shared minutes, action items, decisions
- Cross-department task hand-offs (e.g. Sales → Design/Production for custom approval)
- Escalation alerts to department heads on overdue critical tasks

## 4. Finance & Fund Planning ✅
**Purpose:** End-to-end finance — operating expenses, rental models, sales margins.
- Finance module: general ledger, AP/AR, automated MIS reporting
- Operational cost tracking: per-store fixed (rent, utilities) + variable (salaries)
- Budget vs actual variance at store and regional level
- Cash-flow forecasts (rentals, salaries, new-store setup)
- Expansion pipeline cost templates (start dates, setup cost, salary structures)

## 5. Catalogue & Product Management ✅
**Purpose:** Unified inventory indexing across locations, including custom orders.
- Multi-store + custom-order support (standard stock, unique bridal sets, per-store ranges)
- Unified product view across all locations from one dashboard
- Automatic cataloguing: new/custom products tagged + registered across stores in real time
- Auto-availability status: in-stock vs lead-time (production/warehouse) items
- **AI image-based search:** upload a design image (Pinterest/sketch) to find matching/similar catalogue items

## 6. HRMS & Geo-Tagged Attendance ✅
**Purpose:** Staff rosters, attendance verification, sales incentives.
- Geo-tagged attendance: check-in/out verified at store/branch coordinates
- Leave & shift management across all stores
- Sales staff leaderboards: footfall attended → quotes made → sales closed
- Automated commission engine (incentives from closed sales + target achievement)

## 7. Customer Check-ins & Footfall ✅ (CCTV ❌ dropped)
**Purpose:** Track customer traffic and sales-rep allocation.
- Time check-in: log customer entry and exit
- Relationship tracking: which sales executive attended which customer
- ❌ **CCTV/camera footfall analytics — DROPPED.** Footfall is manual/tablet check-in only.

## 8. Timelines & Status Tracking ✅ ⚠️
**Purpose:** Real-time progress engine for custom orders and stock movements.
- End-to-end workflow: Customer → Store Manager → Branch Office → Production Factory
- Role tagging: salespeople, back office, "back boys" (runners/helpers)
- Replenishment tracking: raw material/stock from factory/warehouse → storefront
- ⚠️ **Customer view-only timeline** (Gold melting → Designing → Stone setting → Ready) is OPEN: decide internal-only vs customer-facing before building. See DECISIONS.md.

## 9. Inventory, Stock Management & Merchandising ✅
**Purpose:** Inventory optimization, aging stock control, scrap recycling.
- Dead stock & aging trackers (items not moving within a period)
- Stock rotation suggestions (move slow stock Store A → Store B by regional demand)
- Melting & scrap workflows (items melted/refined → resulting raw metal scrap)
- Auto-reorder alerts with recommended PO quantities at threshold

## 10. Reporting & DSR (Daily Sales Report) ✅
**Purpose:** Automated daily reporting and store analytics.
- DSR automation: walk-ins, total sales, payment-source breakdown (Cash/Card/UPI/Net Banking), store-wise revenue
- Automated push: DSR to owner's WhatsApp + email every evening
- Trend analysis: slow vs fast movers, store benchmarking, production bottlenecks
- *Note:* existing DevExpress `.repx` templates in `SJEP REPORT/Reports/` may be reused.

## 11. Departmental Setup for New Stores ✅
**Purpose:** Project management for launching new locations.
- Five-department checklists with dependencies: IT (network), Inventory/Production (initial stock), Interiors (fit-out), HR (hiring/training), Marketing (launch)
- Milestone alerts at 30/60/90 days before launch
- Vendor assignment: tasks to contractors/vendors with due dates

## 12. Payment Collection Tracking ✅
**Purpose:** Centralized payment-collection ledger.
- Cross-operation tracking: cash receipts, bank transfers, card settlements, online gateways
- Reconciliation engine: store-reported collections vs bank statements

## 13. Ticketing & Issue Management ✅
**Purpose:** Internal helpdesk for operational issues.
- Multi-store ticketing (system bugs, display maintenance, logistics delays)
- Auto-routing to resolver teams (IT, HR, Maintenance)
- Pattern recognition: group recurring tickets to fix structural issues

## 14. Returns & Exchange Management ✅
**Purpose:** Standardize returns, exchanges, repairs.
- Photo-based intake: pictures of returned jewelry/repairs/old-gold trade-in at intake to document condition
- Refund & credit workflows: exchange-value calc, credit notes, refund approvals

## 15. Discount Management ✅
**Purpose:** Control and audit discount approvals.
- Role-based discount limits (e.g. Rep ≤2%, Store Mgr ≤5%, Area Mgr ≤10%, HO above)
- Margin-impact preview: real-time profit-margin analysis before approval
- Audit trail: discount usage analytics + customer discount history

## 16. Marketing Management ✅
**Purpose:** Coordinate external campaigns and agency deliverables.
- Agency collaboration portal: assets + tasks shared with external agencies
- Jewelry-specific campaigns: bridal season, festive discounts, catalog distribution

## 17. Loyalty & Gold Savings Scheme ✅
**Purpose:** Manage recurring gold-savings accounts (monthly deposits).
- Scheme enrollment: onboarding + monthly installment plan selection
- Collection tracking: payments online or in-store
- Maturity calculator: end-dates + final buying power/discount
- Default risk flags: customers who miss payments or default

---

## Cross-cutting concerns (apply to every module)
- **Multi-store scoping** + **role hierarchy** (salesperson → store manager → area/HO).
- **Channels:** WhatsApp, in-store terminals, e-commerce website, phone/SMS.
- **Migration:** historical data/schema lives in `SJEP BACKUP/` (APRS/SJEPlus). Reuse where possible.
