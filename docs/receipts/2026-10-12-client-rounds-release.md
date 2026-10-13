# Production changes — 12 October 2026

Owner's go-ahead in chat: "check the prs and merge if everything is right then
deploy it as well". Times IST. No personal data here.

## Releases

| Commit | What |
|---|---|
| `697b2c8` | PR #40 (Sneha): the client rounds of 9 and 10 October. Sidebar in the client's shape; staff edited in place on People & Access; custom roles; area managers on several branches; per-person location exemption; dated weekly offs; customer tags and guarded delete; referral accounts; per-store commission; reorder requests; scheduled reports on the staff WhatsApp line; leads came vs converted on the dashboard; quote PDF as a stamped draft for deciders; the product renamed CaratSpace. Plus the review fixes in the decisions of 12 October. |
| `729230d` | PR #42 (Sneha): campaign and walk-in conversations written in the dashboard, with an AI-replies switch. Plus the review fixes. |

Each push to `main` deploys Vercel and the Railway backend.

## Database

Six additive migrations from PR #40, applied by Railway's pre-deploy
`prisma migrate deploy`: two columns on `User` (`geoExempt`, `customRoleName`),
one on `AttendanceRecord` (`geoWaived`), two on `ScheduledReport`/`Run`, two on
`SpecialRequest`, a new enum value `reorder`, and four new tables
(`StaffDayOff`, `CustomRole`, `PartyTagAssignment`, `CommissionPlan`). No column
is dropped and no existing value changes. One index is renamed
(`AdSpendCoverage_org_asset_date_key`). Restore point: none taken; the changes
are additive.

## Checked before release

- Backend e2e, full suite on both PRs merged together: 159 suites, 2,338 tests passed, 0 failed (6 skipped).
- Frontend: typecheck clean, 186 unit tests, production build compiles.
- The schema diffs empty against a database migrated from zero.
- Every review fix has a test that failed before it: 9 on #40, 9 on #42
  (#42's checked by breaking each fix in turn).
- Not checked: nothing was clicked on the live site with a real login.

## Data written to production

None by hand. No campaign has a first reply and no walk-in conversation is
enabled, so the customer bot behaves exactly as before until head office
writes one.

## Still open

- `PATCH /users/:id/stores` has no "target already in your scope" check; a
  referral credit is not tied to a real sale; one head office can reset another
  head office's password. All predate these PRs.
- Branch-less scheduled reports made by managers before this release keep
  running until edited; saved WhatsApp numbers are not re-checked at send time.
- The scheduled-reports screen still offers "Every branch" to managers (the
  server refuses it).

## Rollback

- Code: revert the two merge commits (`git revert -m 1`).
- Schema: additive; leave the new tables and columns in place.
