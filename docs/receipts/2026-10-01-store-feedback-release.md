# Production changes — 1 October 2026

Owner-approved in chat ("toh ye sara fix kardo", on the list of eleven items from
the Bandra store's feedback of 30 September). Times IST. No personal data here.

## Restore point

None taken. Both migrations only add nullable columns and change no existing
value:

- `20260930120000_conversation_source_platform` (PR #21, Sneha): `Conversation.sourcePlatform`.
- `20261001120000_quote_line_discounts_and_remark`: `QuoteLine.metalDiscountPercent`,
  `QuoteLine.makingDiscountPercent`, `QuoteLine.remark`.

## Releases

| Commit | What |
|---|---|
| `f53d35f` | PR #21 (Sneha): inbox filter by branch, platform of an ad lead, bot reads answers in the customer's own words. Includes `5ddff4f`, a fix added before merging: the bot matched phrases inside other words ("now" as "no"). |
| `eb9c86b` | Opens on sign-in; sign in by mobile or personal email; no idle sign-out; punch screen first; "Attendance only" preset. |
| `db43d88` | A discount on each quote line; a note on each item; PDF prints both. |
| `54e51bb` | New quote on its own screen, laid out like the bill; searchable metal; no multiplier, stone size or metal colour. |
| `65ca77e` | Quote item master and design materials rebuilt hourly from the mirrored Gati tables. |

Each push to `main` deployed Vercel and the Railway backend; every one reported
success and `/health` 200 afterwards.

## Checked before release

- Backend e2e, full suite on the final tree: 2,094 passed, 4 failed. The same 4
  fail on `f53d35f`, before any of this: `hrms-ops` ("a locked month refuses
  edits", 409 expected, 200 returned) and three `sync-generation-fence` timeouts.
  Not caused by this release and not fixed by it.
- Frontend: typecheck clean, lint 0 errors, 89 unit tests.
- In the running app (local, throwaway database): root opens on sign-in; a quote
  priced from the shop's own example comes to 1,29,480 taxable and 1,33,365 in
  total and saves; its detail shows each line's discount and the note; a
  salesperson set to "Attendance only" lands on the punch screen, then on
  attendance, and is refused CRM.
- The Gati item-master mapping, on the 4 August export: 938 designs, 4,402
  material lines; style 10778RG as Gati shows it.

## Data written to production

By the software, not by hand: the hourly item-master refresh upserts `Material`,
`MaterialSize` and `StyleBom` from the mirrored Gati tables and writes one
`materials.import` audit row (actor "Item master from Gati") per run that
changed something.

Nothing was set to "Attendance only": head office presses that button.

## Rollback

- Code: revert the four commits above (`65ca77e`, `54e51bb`, `db43d88`, `eb9c86b`).
  The landing page and the idle sign-out come back with the revert of `eb9c86b`.
- Schema: additive. The three `QuoteLine` columns can be dropped once no quote
  made after this release needs its per-line discounts.
