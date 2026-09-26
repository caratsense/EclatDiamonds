# Production data write - 23 September 2026

The legacy ERP's business data, read out of a backup file and loaded through the
sync API. Owner-instructed in chat ("jitna possible data dal sakta hai dal de"),
and the owner enrolled the agent and ran the push themselves. Times UTC.

## Why it was done this way

SQL Server could not be started on the machine holding the data: the service
refuses without admin (`Access is denied`, tried three ways) and `master.mdf` is
unreadable. So the 8 Jun 2026 `APRSSJEP.bak` was decoded directly, page by page,
by the scripts in `synceclatcaratsense/bak_export/`. The backup was only read.

## What went in

Through `POST /sync/<entity>` as an enrolled Gati Connect agent, in dependency
order. **16,543 upserted, 0 skipped** - every foreign key resolved, so no line
was orphaned from its header and no piece from its design.

| entity | sent | result |
|---|---:|---|
| stores | 8 | 0 created, **8 updated** |
| staff | 13 | 13 created, all pending activation |
| parties | 564 | 564 upserted |
| products | 753 | 753 upserted |
| stock | 2,690 | 2,690 upserted |
| sales | 213 | 213 upserted |
| sale-lines | 2,230 | 2,230 upserted |
| orders | 121 | 121 upserted |
| order-items | 1,220 | 1,220 upserted |
| bags | 1,102 | 1,102 upserted |
| ledger | 475 | 475 upserted |
| stock-movements | 7,175 | 7,175 upserted |

Every batch's acknowledgement was checked the way the on-site connector checks
one - entity, received equals sent, upserted plus skipped equals received - and
the run was written to stop on the first batch that did not add up.

## The agent

A **separate** agent, `Backup import`, enrolled for this and pinned to this
source: profile `gati-sjep-legacy-v1`, profile hash `294f8ac8...`, source
instance hash `ede01096...`, config revision `f0afcb72...`,
`unattributedMode: holding`. The shop's own `ECLAT AGENT` was left untouched, so
nothing here widened what it is allowed to do. **This agent's token should be
rotated now that the import is done.**

## Read back afterwards

- **Stores: 13, none created.** The eight legacy branches matched the stores
  Eclat already had under different names ("MUMBAI BANDRA" onto "Mumbai -
  Bandra"), so no twin was created. This is the `planAdoptions` guard doing
  exactly what its comment says it exists for.
- **Stock landed by branch**, 2,267 pieces on hand: Bandra 485, Udaipur 264,
  Bandra Broadway 244, Kalaghoda 202, Paschim Vihar 194, Rohini 185, Hyderabad
  178, Borivali 123.
- **392 pieces are in the holding bucket** - the rows whose `BranchNo` is NULL in
  the legacy data. They are visible and pending a decision rather than quietly
  attached to a default store, which is what that bucket was built for.
- Parties 729 total; products 1,155 total.

## Not verified

**The money on the 2,230 sale lines has not been read back.** No API exposes
`SaleLine` - `GET /sales/:id` returns the header, its party, store and payments,
but not its lines - and direct database access was refused. What is known:

- The mapping fix (PR #15, commit `6692164`) was deployed and its check was
  green before the import ran, so the import ran against the corrected handler.
- Its e2e test asserts metal + making + stone + exchange equals the line total.
- All 2,230 lines upserted with 0 skipped.

That is good evidence and it is not the same as having looked. Until a sale's
lines can be read, nobody can confirm from outside that the making charges
landed. Adding `lines` to `GET /sales/:id` would close this, and would also fix
a sale detail that cannot show what was sold.

## What was deliberately left out

- **Supplier pricing.** The 26 `JWPH`/`BJWPH` purchase invoices - Rs 5.86 crore
  of what the shop paid its vendors - were dropped from the sales extract. The
  `JWBAP`/`JWBAI` branch transfers were kept; they are not purchases.
  `InwardSummary.COST` is fully populated in the source and was never emitted.
- **Passwords and hashes**, from `SPM_Users` or anywhere else.
- **Invented values.** A destination field with no source was left out, so a gap
  in the data reads as a gap and not as a zero.

## Gaps that are the source's

- No geo coordinates exist anywhere in the legacy schema.
- `Inward.BranchNo` is NULL on 1,426 of 2,690 stock rows - hence the 392 in
  holding.
- `IsLocation` is false on all 564 parties, so branches had to be found through
  `BookMaster.BranchNo`.
- Staff contact details are not recorded: 13 people, no email or phone. They
  imported as inactive users pending activation and cannot sign in.

## Still to decide

A store `surat-main`, named "Surat - Main", is live alongside the real branches
and holds no stock. That id is the development seed's (`prisma/seed.mjs`).
Somebody should close it or remove it.

## How to reverse

Every row carries its `legacyId`, so the import is identifiable and re-runnable.
`POST /sync/purge-demo` removes seeded demo rows by the same provenance rule.
Reversing the import itself means deleting by `legacyId` per table; there is no
one-button undo, and there was no pre-import snapshot, because database access
was refused throughout.
