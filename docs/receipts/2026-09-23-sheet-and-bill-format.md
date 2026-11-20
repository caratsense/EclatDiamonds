# Production change — 23 September 2026, second release

Owner merged PR #13 themselves, in chat ("done"). Times UTC. No personal data
here.

## What changed

Code only. **No migration, no schema change, no data written** — unlike the
earlier release the same day ([2026-09-23-store-lifecycle-release.md](2026-09-23-store-lifecycle-release.md)),
this one touches nothing in the database, so it needs no restore point.

The DSR sheet and the quotation PDF had both been built from a description of
the store's formats rather than from the formats themselves. Put the owner's two
reference copies beside what we were producing and closed every gap: the sheet's
own row wording, its two table banners and their repeated day columns, "Gold"
as a heading over "Weight" and "Value", "Amount Received" as a heading rather
than a figure, a "Remark:" row, the sheet's blank lines, full day names, seven
columns for a week, and plain figures (`1603822`, not `16,03,822`). On the
quotation: the bill's HUID / HSN No / StyleCode / J_Certi labels in its order,
"INR" rather than "Rupees" in the amount in words, the Bank Address row, the
Remarks column, the bill's four payment rows, and the GST Act clause and
conflict-diamond declaration restored to the shop's own wording.

The Total column we had invented stays only on a month's sheet, whose columns
are weeks — a shape the paper sheet has no version of.

Tested on the merged tree before the merge: **134 suites, 2,025 tests, 0
failures**; `tsc` clean; eslint 0 errors on the touched files. Both documents
were rendered and read back against the reference photos.

## Release — PR #13, merge commit `c618938` (merged 15:01:58)

- Backend: Railway production `backend`, commit `c618938`, **SUCCESS**,
  15:02:01. GitHub check green at 15:09:47.
- Frontend: Vercel production, **success**, 15:02:30.
- Smoke through `https://eclat-diamonds-pi.vercel.app` and its `/_api` proxy:
  `/login` 200, `/_api/health` 200, `/_api/reporting/daily/sheet?…&format=xlsx`
  401 (present, behind sign-in).

## Still open from the earlier release

The five branch rows written by `20260922160000_store_location_repair` have
still not been read back; the attempt was refused as a production read. Nothing
in this release changes that.

## Not yet wired

`HSN No :` prints empty on the quotation. The code exists on the design
(`Product.hsn`) but a quote line holds its style as a string and does not join
to it. HUID and the lab certificate are properly empty on a quotation — they
belong to a piece that has been made.

## How to reverse

Revert `c618938` in a PR; Railway and Vercel redeploy on push. Nothing else to
undo.
