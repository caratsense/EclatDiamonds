# Production changes: 1 to 2 October 2026 (follow-up)

Owner-approved in chat ("i want everything fixed from your end", 1 Oct, on the
eight points still open after the release of 1 October). Times IST. No personal
data here.

## Restore point

None taken. No migration in any of these releases; no existing value is changed.

## Releases

| Commit | When | What |
|---|---|---|
| `1db76b8` | 1 Oct, night | Quote builder: item type and metal are lists you type into; karats offered are 9, 12, 14, 18. Test-only fixes for two specs that failed on the first days of a month and on a slow run. |
| `6f8b6aa` | 2 Oct, 00:33 | Security: a password can be set only inside the caller's own organisation; every reset is audited; the sign-in lockout counts a mobile number as one handle however typed. |
| `f413508` | 2 Oct, 00:36 | Sales staff can start with attendance only as a workspace rule (`ATTENDANCE_ONLY_SALES_ORGS`, off). Work is not given to somebody who cannot open it. "Pieces on hand" and "Stock Pieces" count pieces on hand. |
| `2ed4cc3` | 2 Oct, 01:22 | Sign-in screen with no sign-up; a manager sets the first password in Add staff; the punch screen for attendance-only staff; the morning digest under the rule; two specs made independent of the date and of the punch tab. |
| `a37e16a` | 2 Oct | PR #22: the script that records which platform an older ad lead came from. Reports by default; a write is audited. Not run on staging or production. |

Each push to `main` deployed Vercel and the Railway backend; each reported
success and `/health` answered 200 afterwards.

## Checked before release

- Backend e2e, full suite on the final tree (`2ed4cc3` before its last commit):
  2,136 passed, 2 failed, 6 skipped. Both failures were checks that read the
  punch screen's tab as a module; fixed in the tests and re-run with their
  neighbour: 3 suites, 124 tests, all passing. The four failures listed on the
  1 October receipt are fixed (they were faults in the tests).
- Frontend: typecheck clean, lint 0 errors, 171 unit tests.
- The three new security tests fail without the fix and pass with it.
- In the running app (local, throwaway database, the rule ON for the seeded
  organisation): the root opens on sign-in with no sign-up on it; a store
  manager adds a member of staff with a password in one form; that person signs
  in with their mobile number, lands on the punch screen, is checked in inside
  the shop's fence, checks out and sees "Done for today"; their token is refused
  the leads API (403); 700 m away the screen says how far and from which branch
  and does not check in.
- Not checked: nothing was clicked on the live site with a real login.

## Data written to production

None by hand. By the software: an audit row each time somebody resets a
password (`user.password_reset`).

## Not done: the rule is off in production

`ATTENDANCE_ONLY_SALES_ORGS` was **not** set. The session's permission layer
refused the variable write, so it is the owner's to set:

- Railway > Eclat Diamonds > production > backend > Variables:
  `ATTENDANCE_ONLY_SALES_ORGS` = `org_eclat`. Not on staging.
- The backend restarts and logs `Sales staff start with attendance only in:
  org_eclat`. A warning instead means the id matched no organisation.
- From then every salesperson in that workspace has attendance only and lands on
  the punch screen. Leads and threads they already hold stay under their names.
- To undo: remove the id. The usual screens are back at once.

Until then sales staff keep their usual screens; the per-person "Attendance
only" preset under People & Access works as on 1 October.

## Rollback

- Code: revert the commits above, newest first. `6f8b6aa` should stay: it closes
  a hole.
- The rule: remove the id from `ATTENDANCE_ONLY_SALES_ORGS`.
- Schema: nothing to undo.
