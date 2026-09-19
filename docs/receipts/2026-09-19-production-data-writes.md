# Production data writes — 19 September 2026

**No new code was deployed by these actions — but production DATA was written.**
This is the receipt. Every action ran through the application's own services
(the same code the UI calls), so each is also in `AuditLog`, attributed to the
head-office account `u-ho` because the scripts ran as that account. Operator:
Claude Code, on the owner's instruction. Times are UTC (IST = UTC + 5:30).
No personal data is recorded here; ids are internal.

## 1. EzAttendancePRO import — `EmployeesService.importEzAttendance`

Source: the EzAttendancePRO export of 18 Sep (Employee-Master-Full.csv,
Leave-Balance-2026.csv, Todays-Punch-2026-09-18-FULL.csv). Preview first
(nothing saved), then one atomic apply.

| Audit action | Count | Window (UTC) |
|---|---|---|
| `employee.create` (User + EmployeeProfile, no login, `isActive=false`) | 30 | 05:22:08 – 05:23:51 |
| `leave_balance.import` | 53 (29 people) | 05:23:53 – 05:25:09 |
| `attendance.import` for 2026-09-18 | 17 (10 present, 7 absent) | 05:25:12 – 05:25:49 |
| `employee.import_ezattendance` (run summary) | 1 | 05:25:50 |

Also created by the import: 7 departments, 10 designations, 7 store shifts, 17
shift assignments. Department → store mapping (from EzAttendance's own
Organisation-Masters): Ashok Nagar → UDAIPUR ASHOK NAGAR, BANDRA → MUMBAI
BANDRA, Kala Ghoda → MUMBAI KALAGHODA, Rohini → DELHI ROHINI, Paschim Vihar →
DELHI PASCHIM VIHAR, Hyd Broadway → BANJARA HILLS HYD, HEAD OFFICE → no store.

Skipped by the import: 14 attendance rows for 2026-09-18 (13 head-office staff
have no store; 1 code not in the employee master).

**Not imported (not in the export):** weekly-off days, holiday dates, late-grace
minutes, half/full-day thresholds — the export names these rules but not their
contents.

## 2. Demo staff removed — `HrmsService.deleteAttendance`, `EmployeesService.bulk`

The three live accounts absent from EzAttendance, each named as test/demo (a
store manager and a salesperson at MUMBAI BANDRA, a salesperson at Surat —
Main). The script ran twice: the first pass deleted 114 rows and one hit a
transaction timeout; the second deleted that last row and repeated the
deactivation.

| Audit action | Count | Window (UTC) |
|---|---|---|
| `attendance.delete` (reason recorded; each row's punches voided, not erased; the full row is in the audit entry's `metadata.before`) | 115 | 05:28:30 – 05:40:30 |
| `employee.deactivate` | 6 entries for 3 accounts (2 runs) | 05:39:11 – 05:41:12 |

Accounts (now `isActive=false`): `cmsk7eyx40014qs017378i0fy`,
`cmszr6r280000m101p65tnb61`, `cmsk7eusv000zqs0139r1z5py`.

## 3. Website catalogue — connected, then reverted

| When (UTC) | What | Audited |
|---|---|---|
| 05:56:30 | Website connection row created (`integration.credential_set`), and a DRY-RUN sync queued | yes |
| ~06:05 (exact: the run's `finishedAt`) | Reverted, on the staging-first instruction: the connection row deleted, the dry run marked `failed` and its job `dead` ("Cancelled: production website sync deferred until staging proof"). The dry run had written nothing; 0 website listings before and after. | **no — done directly in the database, recorded here** |

Production's website catalogue is "not configured".

## How to reverse

- Demo accounts: `POST /hrms/employees/bulk {action:"activate"}` with the three ids.
- Deleted attendance rows: each is in its `attendance.delete` audit entry
  (`metadata.before`); the voided punches are still in the punch ledger.
- The import: deactivate or separate the 30 `source=ezattendance` profiles; the
  leave balances and attendance rows carry `*.import` audit entries.
