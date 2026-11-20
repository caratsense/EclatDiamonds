# Production changes — 19 September 2026, afternoon

Follows `2026-09-19-production-data-writes.md`. Owner-approved in chat. Times
UTC. No personal data here; ids are internal.

## Restore point

`C:\Users\Shrey\Eclat-backups\prod-2026-09-19-before-releases.dump` — `pg_dump`
custom format, 62 MB, 10:42 UTC, before any of the writes or deploys below
except Release 0 (whose migration only added two columns). `pg_restore --list`
shows all 145 data tables. Kept on the owner's machine, outside the repo and
OneDrive: it contains staff personal data.

## Release 0 — attendance gate (deployed 09:18)

Backend deployment `38a0c0b4` (commit `69249a0`), migration
`20260919100000_attendance_rules_gate` applied by the pre-deploy step; frontend
`eclat-diamonds-o602gpcsf`. No location has confirmed attendance rules, so no
automatic absence is written anywhere until head office confirms them.

## Head Office location — `ho_location.cjs`

| Audit action | Count | Note |
|---|---|---|
| `store.create` | 1 | `HEAD OFFICE`, Mumbai, `attendanceOnly`, no coordinates or radius (geofence unverified). Store id `cmu89fbmx0001rmug4upyv3ln`. |
| `employee.update` | 13 | The EzAttendance HEAD OFFICE staff, moved onto it. |

The first run created the location, then its first staff update hit the app's
5-second transaction limit over the slow link and rolled back (nothing half
written). The rerun, with a longer limit in the script, reused the location
and moved all 13.

## Staff sign-ins — `staff_logins.cjs`

| Audit action | Count | Note |
|---|---|---|
| `user.login_issued` | 30 | Login ID and a random 12-character password. Metadata holds the login ID before/after, never the password. |
| `employee.activate` | 30 | Accounts switched on. |

Login IDs: 18 are the person's personal email on file; 12 keep their app ID
(11 have no email, 1 is mistyped `@gamil.com`). Every password was checked
against its stored hash (30 of 30). The only copy of the passwords is
`C:\Users\Shrey\Eclat-staff-logins\staff-logins-2026-09-19.csv` on the owner's
machine. The app cannot force a change at first sign-in.

Self check-in: 12 of the 30 are at a location with a geofence; 18 are not
(13 at HEAD OFFICE, 5 at stores without coordinates) and need a manager to
mark them until coordinates are set.

## Releases deployed after the restore point

Full backend suite on the combined code first: 128 suites, 1,949 tests passed
(6 live-inference skipped). Each release deployed on its own, backend then
`main` pushed to the same commit for Vercel:

| Release | Commit | Backend deployment |
|---|---|---|
| Website connection truth | `b330941` | `0673071f` |
| IBJA rates | `a6d509a` | `601b2263` |
| Dead stock / KPIs / ticket and request dialogs | `c4f0d59` | `741b069c` |

Website, production (audited `integration.credential_set` and
`catalogue.website_sync_started`): Save and test passed at 11:10 (331 designs,
GET only, no token). Dry run `cmu8ae7hb0001rmu42pzhgdtf`: expected 331,
received 331, failed 0, nothing written; would create listings for 331 (116
matched to Gati designs, 215 not), all 331 flagged for review. The 198
website products an earlier import created carry the same `WEB-<code>` key, so a
full sync updates them rather than duplicating them. **The full sync has NOT
been run; it waits for the owner's approval.** The weekly sync cannot start it
(it needs a finished first full sync).

## Later releases the same day

DSR "All stores reports" (`1efb314`, backend `0a67f2ba`) and roles & per-person
access (`6745ad0`, backend `f4363430`, migration
`20260919140000_marketing_role_and_access`). A backend redeploy at 12:37 UTC
(`68bb92aa`) was not started from here; it ran the same code (118 migrations,
none pending) — most likely a variable change in the dashboard.

## Website full sync — approved by the owner, 15:38

Restore point first: `C:\Users\Shrey\Eclat-backups\prod-2026-09-19-before-website-full-sync.dump`
(62 MB, 15:36 UTC, 145 data tables).

Run `cmu8jxhym0001rm6sfrn61hyp` (audited `catalogue.website_sync_started`),
15:38:05–15:40:30 UTC: expected 331, received 331, failed 0, tombstoned 0.

| | Before | After |
|---|---|---|
| Products | 1,138 | 1,155 (+17: website-only designs not imported before) |
| Linked to the website | 198 | 331 (116 on Gati designs, 215 website-only) |
| Website listings | 0 | 327 active + 4 unpublished |
| Website variants | 0 | 993 |
| Active photos | 940 (198 website, 742 other) | 3,541 (2,880 website, 661 other) |

The 198 earlier website products were updated, not duplicated. 81 photos that
the earlier import had stored as `other` are the same website photos and are now
attributed to the website (not deleted); 2,601 photos are new and queued for
thumbnails and visual search. Designs missing a Gati CAD: 939 before and after.
Open conflicts for review (Gati stays master): 331 unit mismatches, 215 with no
Gati design, 360 spec mismatches.

## How to reverse

- Sign-ins: `POST /hrms/employees/bulk {action:"deactivate"}` for the 30, and
  set each login ID back from its `user.login_issued` entry.
- Head Office: move the 13 back (`employee.update` with no store), then close
  the location.
- Everything: restore the dump above (or the pre-sync dump for the sync alone).
