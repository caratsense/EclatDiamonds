# Production changes — 22 September 2026

Owner-approved in chat ("merge the new PRs … and deploy"). Times UTC. No
personal data here; ids are internal.

## Restore point

`C:\Users\Shrey\Eclat-backups\prod-2026-09-22-quote-dsr-tables.dump` — `pg_dump`
custom format of the three tables this release alters (`Quote`, `QuoteLine`,
`DailyReport`), 16 KB, 08:32, before the deploy. `pg_restore --list` shows all
three tables' data. A full dump was started first and abandoned: over the
hotspot it ran at ~3 KB/s (about five hours for the whole database). The
migrations only add tables, columns and an enum value, and fill the new
discount columns from the existing one; no existing value is changed.

## Releases

| PR | What | Merge commit |
|---|---|---|
| #9 (Sneha) | Photos kept and shown, intent score wired, no invented store | `8b96675` |
| #10 | Quotes priced from the ERP item master, split discounts, bill-style PDF; DSR sheet PDF (day/week/month), bank transfer, remark; dialogs stay open on a background click; sidebar screen search; karats 9/12/14/18/22/24 | `f777251` |

Before merging, both were combined locally and tested together: full backend
e2e 1,994 passed; the only failures were the 2 `omnichannel-optout` tests,
which fail identically on the previous `main` (`d6f67b8`). `main` after the
merges is byte-identical to that tested tree.

- Backend: deployment `1d523b40` (commit `f777251`) SUCCESS 08:52. The `8b96675`
  build (`aacc9a60`) was superseded before it served. Pre-deploy applied
  `20260922100000_material_master_quote_discounts_dsr_bank` and
  `20260922120000_gold_12k` (08:52:48); no errors at start, no 5xx after.
- Frontend: Vercel production `f777251` (deployment 6586950060) success.
- Smoke: `/login` 200, `/_api/health` 200, `/_api/materials` 401 through the
  production proxy (the new route is live and requires sign-in).

## Item master load — `prod_materials.cjs` (after the deploy)

The SJEP item master, built by `synceclatcaratsense/bak_item_master.py` from the
8 Jun 2026 `APRSSJEP.bak` (plus ANKLET from the live ERP), loaded through
`MaterialsService.import` — the code behind `PUT /materials` — as head office.
The file passed the endpoint's own validation first; a dry run found the two
release migrations applied, one organisation and empty tables.

| Audit action | Count | Note |
|---|---|---|
| `materials.import` | 1 | `cmuchi5gz0293rmngud3aua0i`, 09:41. 177 items (10 item types, 23 metals, 111 diamonds, 25 colour stones, 5 charges, 3 other), 529 stone sizes, 753 style BOMs. Sale rates only, no cost. 1,067 s over the hotspot. |

Read back: `ALR-0006` → ALR, IND 13, 5 material lines; the builder's lists
return 10 item types, 23 metals, 111 diamonds, 25 stones, 529 sizes.

Then one IBJA read (the scheduler's own `GoldRateService.refresh`, run once so
12K did not wait up to three hours): publication of 2026-09-21 stored, 24K
₹15,213/g, **12K ₹7,606.50/g** (new, 999 × 0.500), 9K ₹5,704.88/g.

Check after: 0 quotes whose old single discount was not carried into the new
making / diamond percentages.

## How to reverse

- Code: revert the merge commits (`f777251`, `8b96675`) in a PR; Railway and
  Vercel redeploy on push.
- Schema: additive. Drop `Material`, `MaterialSize`, `StyleBom`; the new columns
  on `Quote` (`makingDiscountPercent`, `stoneDiscountPercent`,
  `additionalDiscount`), `QuoteLine` (`styleNumber`, `size`, `metalCode`,
  `makingRatePerGram`, `stones`) and `DailyReport` (`customBankTransfer`,
  `remark`). `gold_12k` cannot be dropped from the enum in place; leave unused.
- Data: restore the three tables from the dump above.
