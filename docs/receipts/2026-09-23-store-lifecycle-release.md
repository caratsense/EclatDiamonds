# Production changes — 23 September 2026

Owner merged PR #12 themselves, in chat ("kardiye merge"). Times UTC. No
personal data here; ids are internal.

## Restore point

**None was taken for this release.** That is a gap, recorded here rather than
glossed over. The 22 Sep dump covers `Quote`, `QuoteLine` and `DailyReport`
only, and does not contain the `Store` rows this release rewrites. Reversing the
store repair would have to come from Railway's own Postgres backup for
2026-09-23, or from the branch details being re-entered by hand.

The reason: access to the production database was denied to the agent during
this release (`railway link` refused as sensitive remote exec), so neither a
dump nor a before-snapshot could be taken. The merge went ahead on the owner's
instruction with that known.

## Release — PR #12, merge commit `9b6c7cc` (merged 11:58:46)

| Commit | What |
|---|---|
| `9636863` | Real branch names, codes and coordinates; head office marked attendance-only; an import holding bucket; a `pending`/`active`/`closed` branch lifecycle |
| `58db1b9` | Phone boxes stop at ten digits; no weight, size, rate, carat or discount box accepts a minus (45 files) |
| `8292482` | The quotation PDF is the shop's own bill; style-number search finds a code by any part of it and fills the BOM; size moved into the item section; the quote-approvals card rewritten |
| `ec16646` | The DSR sheet as Excel for a day, a week or a month, with download and send (self / email / WhatsApp) |
| `b52e218` | The gold-rate chip in the top bar carries the rate's "as of" date |

Tested before the merge, on the merged tree: backend e2e **134 suites, 2,024
tests, 0 failures**; frontend `tsc` clean, eslint 0 errors (26 pre-existing
warnings), `next build` compiled.

- Backend: Railway deployment `b143b6c5` (commit `9b6c7cc`) **SUCCESS**,
  started 11:58:51. `railway.json` runs `prisma/pre-deploy.mjs` as
  `preDeployCommand`, whose first step is `prisma migrate deploy`; a non-zero
  exit there fails the deployment and the new instance never boots. The
  deployment reported success and the new code is serving, so
  `20260922160000_store_location_repair` applied.
  Railway's own record for the production `backend` service: deployment
  `4c1630e8`, commit `9b6c7cc`, branch `main`, **SUCCESS**, 11:58:48.
- Frontend: Vercel production (commit `9b6c7cc`) **success**, 11:59:47, at
  `https://eclat-diamonds-6j2lv3z3u-carat-sense-s-projects.vercel.app`. (The
  docs name `app.caratsense.in`, which does not resolve — NXDOMAIN from a public
  resolver, so not a local network fault. `eclat.vercel.app` is a placeholder
  page and `eclat-diamonds.vercel.app` is the storefront site; neither is this
  app.)
- Smoke, 13:11:45 direct against the backend: `/health` 200;
  `GET /reporting/daily/sheet?…&format=xlsx` **401**, not 404 — the route added
  in `ec16646` exists and requires sign-in.
- Smoke through the deployed frontend and its `/_api` proxy: `/` 200, `/login`
  200 and titled "CaratOS", `/_api/health` 200, `/_api/reporting/daily/sheet`
  401. So the browser path a member of staff actually uses is serving the new
  build and reaching the new backend.

## Data written by this release

`20260922160000_store_location_repair` is not additive. Inside the deploy, as
part of the migration, it writes live `Store` rows: the tenant is resolved by
slug, the five branches get their exact codes, names and coordinates, regions
are reused where they exist and created where they do not, head office is set
`attendanceOnly` with its coordinates, and five branches are activated. The
holding-bucket match is narrowed to `isAggregate = false AND name LIKE
'Unassigned%'` so it cannot claim a real branch or a rollup row.

This is a production data write carried inside a schema migration rather than
through an audited service, which is the exception this project otherwise
avoids. It is the subject of the branch, so it could not be separated; it is
called out here so the next person knows the deploy moved data.

## Not verified

Two checks from the usual post-deploy list could not be run. Both are
read-only, and both were attempted and refused by the agent's own permission
layer — `railway link` as sensitive remote exec, then
`railway run -s Postgres -e production -- …` as a production read.

1. Reading the five branches, the head-office location and the holding bucket
   back out of production to confirm the migration's result.
2. Rendering one real quotation PDF from production to see the new bill layout
   against live data.

The first is `scratchpad/stores_snapshot.cjs`; `backend/` is already linked to
this project's production environment, so it runs as
`railway run -s Postgres -e production -- node stores_snapshot.cjs`.

What this leaves: the migration is known to have **executed** (a failing
pre-deploy step fails the deployment, and the deployment succeeded), but its
**result** has not been looked at. Nobody has yet seen the five branch rows as
they now stand.

## How to reverse

- Code: revert the merge commit `9b6c7cc` in a PR; Railway and Vercel redeploy
  on push.
- Schema: additive parts are `Store.isHolding` and the branch-status column.
  Dropping them is safe once nothing reads them.
- Data: the store repair has no captured before-state. Use Railway's Postgres
  backup for 2026-09-23, or re-enter the branch rows by hand.
