# Reading the legacy ERP out of a backup file

The on-site connector (`../sync_sjep.py`) reads the live SJE Plus SQL Server.
When that server cannot be started — no admin rights on the machine, or the
shop's PC is not to hand — these scripts get the same data out of an `APRSSJEP.bak`
directly, by decoding the backup's 8 KB pages and its system catalog. No SQL
Server is installed, started or touched, and the backup is only ever read.

They exist because that is exactly the situation we were in: the service would
not start (`Access is denied`, and `master.mdf` is unreadable without admin),
and the data was needed anyway.

## Running them

    set SJEP_BAK=E:\...\APRS-SJEP-2606081711\APRSSJEP.bak
    python bak_tables.py "%SJEP_BAK%" tables.json   # what is in there at all
    python parties.py                               # writes parties.json
    python products.py                              # …and so on

Each entity script writes `<entity>.json` next to itself, shaped for the
matching `POST /sync/<entity>`: **raw legacy rows with legacy column names**,
because `SyncService` does the mapping server-side and upserts on the legacy id.
Reshaping them here would miss the handler.

`_reader.py` holds the shared handle — it loads the page reader from
`../bak_item_master.py`, so that file is the one to keep working.

## What they will not emit

- **Cost, purchase rate, margin, supplier pricing.** `InwardSummary.COST` is
  fully populated and is excluded; `sales.py` drops the 26 `JWPH`/`BJWPH`
  supplier invoices for the same reason. Branch transfers (`JWBAP`/`JWBAI`) are
  kept — they are not purchases.
- **Passwords and hashes**, from `SPM_Users` or anywhere else.
- **Invented values.** A destination field with no source is left out and named
  in the script's own notes, so a gap reads as a gap rather than as a zero.

## What the 8 Jun 2026 backup actually holds

1,104 user tables, 264,047 rows — but most of that is configuration and
reference data (`Const_PortCode` alone is 72,830 rows). The business data these
scripts pull is roughly 16,500 records:

| entity | records | from |
|---|---:|---|
| stock-movements | 7,175 | InwardHistory |
| stock | 2,690 | Inward + InwardSummary |
| sale-lines | 2,230 | JewelTransInward + Summary |
| order-items | 1,220 | SPM_MfgOrderItem |
| bags | 1,102 | SPM_BagMaster |
| products | 753 | StyleMst |
| parties | 564 | PartyMst |
| ledger | 475 | Journal |
| sales | 213 | JewelTrans (26 purchases dropped) |
| orders | 121 | Spm_MfgOrder |
| staff | 13 | SPM_Users + PartyMst |
| stores | 8 | BookMaster |

Known gaps in the source itself, not in these scripts: there are no geo
coordinates anywhere in the legacy schema; `Inward.BranchNo` is NULL on 1,426 of
2,690 stock rows, which is what the import holding bucket is for; `IsLocation`
is false on all 564 parties, so branches have to be found through `BookMaster`;
and staff contact details are simply not recorded.

The `.json` files these produce are business data and are **not** committed.
