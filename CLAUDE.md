# Eclat / CaratSense — Agent Context

> **▶ RESUMING ON A NEW MACHINE / NEW SESSION? Read [docs/HANDOFF.md](docs/HANDOFF.md) FIRST** — it has the current status and the exact next step. Then continue with this file.
>
> Single source of truth for any agent working on this project. Read this first.
> Maintainers: @caratsense, @adi-caratsense (https://github.com/adi-caratsense)

## What this is
**Eclat** (product name **CaratSense**) is a unified operations platform for a **multi-store jewelry retail business**. It consolidates sales, inventory, finance, HR, and customer management across all store branches into one system.

It is **not greenfield**. It is layered on / migrating from an existing jewelry ERP called **APRS-SJEP** (SQL Server). Eclat extends and modernizes that system.

## Existing system (do not delete — reference only)
- `SJEP DATA/` — live SQL Server DB (`APRSLog.mdf`, `APRSLog_log.ldf`).
- `SJEP BACKUP/` — dated `.bak` backups of `APRS`, `SJEPlus`, `APRSSJEP` databases (March 2026). Source of historical schema + data.
- `SJEP REPORT/Reports/` — DevExpress `.repx` report templates (bag movement, receipts, prints, etc.). Existing reporting layer.
- `SJEP REPORT/Eclat_RequirementsNotes_CaratSense.pdf` — detailed requirements doc.
- `Eclat_feature planning.xlsx`, `Jewel Modules - Google Sheets.pdf` — planning sources.

## The product: 17 modules
Full spec in [docs/MODULES.md](docs/MODULES.md). Summary:

| # | Module | Domain |
|---|--------|--------|
| 1 | CRM & Lead Management | Sales |
| 2 | Quotation & Pricing Integration | Sales |
| 3 | Departmental Dashboards & Collaboration | Management |
| 4 | Finance & Fund Planning | Management |
| 5 | Catalogue & Product Management (AI image search) | Sales |
| 6 | HRMS & Geo-Tagged Attendance | People |
| 7 | Customer Check-ins & Footfall | People |
| 8 | Timelines & Status Tracking | Operations |
| 9 | Inventory, Stock & Merchandising | Operations |
| 10 | Reporting & DSR | Management |
| 11 | Departmental Setup for New Stores | Management |
| 12 | Payment Collection Tracking | Operations |
| 13 | Ticketing & Issue Management | Back-office |
| 14 | Returns & Exchange Management | Sales |
| 15 | Discount Management | Sales |
| 16 | Marketing Management | Management |
| 17 | Loyalty & Gold Savings Scheme | Sales |

## Scope decisions (see [docs/DECISIONS.md](docs/DECISIONS.md))
- **CCTV integration (was part of Module 7): DROPPED.** Footfall is captured via manual/tablet check-ins only. Do not build CCTV/camera analytics.
- All other 16 modules + the non-CCTV parts of Module 7: **in scope**.
- **Module 8 (timeline external visibility):** open — see DECISIONS.md before building customer-facing timeline views.

## Working conventions for agents
- **Module docs on demand:** there is no per-module file by default. When you start real work on module N, create `docs/modules/NN-<slug>.md` from its MODULES.md section and expand it there. This keeps token cost proportional to work actually done.
- **Don't touch the live DB or backups** (`SJEP DATA/`, `SJEP BACKUP/`) without explicit instruction. Read schema from backups; never overwrite `.bak`/`.mdf`.
- **Multi-store is a first-class concept.** Almost every entity is scoped by store/branch, with role-based views (salesperson → store manager → area/HO). Bake store-scoping and role hierarchy into every data model.
- **Channels:** WhatsApp, in-store terminals, e-commerce website, and phone are recurring integration touchpoints (quotes, DSR, reminders, catalogues).
- Record any new scope decision or resolved open point in `docs/DECISIONS.md`.

## Open questions to resolve before deep build
1. Tech stack / target architecture for Eclat (new app? extend APRS?) — not yet specified.
2. Module 8 timeline: customer-facing or internal-only.
3. Pricing engine source of truth (gold rate feed, making charges) for Module 2.
