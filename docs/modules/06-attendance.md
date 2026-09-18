# Module 6 — Attendance, employee master and reports (build spec, 2026-09-18)

Source: the read-only EzAttendancePRO audit (export kept OUTSIDE the repo at
`C:/tmp/EzAttendancePRO-Full-Export-2026-09-18/` — it holds employee personal
data and must never be committed, pasted into code, fixtures or seed files).

Goal: EzAttendance parity for the client's 30 staff, on the attendance code that
already exists (check-in/out, geofence, shifts, leave, regularization, payroll).
**Extend, never duplicate.** Reuse `StoreScopeService`, `AuditService`,
`NotificationsService`, `tz.util`, `approval.util`, `PayrollService.weekOffs`.

Schema is DONE (migration `20260918120000_employee_master_and_punch_ledger`):
`Department`, `Designation`, `EmployeeProfile` (1:1 User), `ShiftAssignment`,
`RawPunchEvent` (append-only), `AttendanceProcessingRun`, `PayrollPeriodLock`,
`Shift.isFlexible`, `Shift.code`, `LeaveType.week_off_leave`, `EmploymentStatus`.

## Rules every part follows

- Store scope + role: managers (store_manager+) see/act on their stores; head
  office all. Salesperson/storeperson: self only. Use `@Roles('store_manager')`
  (min-rank) for manager routes; masters/import/locks/processing are
  `@Roles('head_office')`.
- Head office MAY edit/delete attendance records (corrections), with audit. This
  reverses the earlier "HO observe-only" for corrections only; HO still does not
  punch for others from the mark dialog.
- Every create/update/delete writes `AuditService` with before/after.
- A write dated inside a locked payroll month (`PayrollPeriodLock` with
  `reopenedAt = null`) is refused with 409 "Payroll for YYYY-MM is locked".
  One helper `assertMonthOpen(orgId, date)` in `attendance-ops.service.ts`,
  exported, used by everyone.
- Eligible employee on a date = User `isActive`, belongs to the store
  (UserStore), role not head_office-only observer (keep current team rule),
  and if it has an EmployeeProfile: `status = active`, `dateOfJoining <= date`
  (or null), `exitDate` null or `> date`. One function
  `eligibleStaff(orgId, storeIds, date)` in attendance-ops, used by Today,
  day-close and reports so the numbers agree.
- Daily state invariant: every eligible employee has exactly ONE primary state:
  `present | half_day | absent | on_leave | week_off | holiday | not_marked`.
  `late` is a modifier of present (count it separately, never add it).
  `present + half_day + absent + on_leave + week_off + holiday + not_marked == denominator`.
- Shift `isFlexible`: never compute lateness or early-out.
- Dates are store-local business dates (`tz.util.businessDate`), never UTC today.

## API contract (all under `/hrms`)

### Masters and employees — `employees.controller.ts` / `employees.service.ts` (backend agent A)
- `GET /hrms/departments` → `Department & { storeName, employeeCount }[]`
- `POST /hrms/departments` `{name, storeId?, sortOrder?}`; `PATCH /hrms/departments/:id` (same + `isActive`); `DELETE /hrms/departments/:id` (409 if employees reference it unless `?reassignTo=<id>`)
- Same four for `/hrms/designations` `{name, sortOrder?, isActive?}`
- `GET /hrms/employees?q&departmentId&designationId&status&storeId` → `EmployeeRow[]`:
  `{ userId, employeeCode, name, phone, loginEmail, personalEmail, role, isActive, storeIds, storeNames, department:{id,name}|null, designation:{id,name}|null, unit, gender, dateOfBirth, dateOfJoining, dateOfConfirmation, exitDate, exitReason, employmentType, status, bloodGroup, address, biometricNo, shiftCode, currentShift:{id,name,startTime,endTime}|null, reportingManager:{id,name}|null, source, hasProfile }`
  Staff users WITHOUT a profile are included with `hasProfile:false` (so the reconciliation is visible).
- `GET /hrms/employees/:userId` → EmployeeRow + `leaveBalances`, `recentAttendance` (last 30 rows)
- `POST /hrms/employees` creates User (inactive until HO issues login — reuse the users service/util for loginId generation) + UserStore + profile. Body: `{name, phone?, role, storeIds[], employeeCode, ...profile fields}`
- `PATCH /hrms/employees/:userId` any profile field + `name`, `phone`, `storeIds`, `role` (role/store change only by head_office)
- `DELETE /hrms/employees/:userId` → marks `separated`, `exitDate` (body `{exitDate?, exitReason?}`, default today), deactivates User. `?purge=1` (head_office) additionally deletes the profile row only when the person has no attendance/leave/payslip history; else 409.
- `POST /hrms/employees/bulk` `{userIds[], action:'separate'|'activate'|'deactivate'}`
- `POST /hrms/import/ezattendance` multipart: `employees` (Employee-Master-Full.csv, required), `leaveBalances` (Leave-Balance-2026.csv, optional), `todaysPunch` (Todays-Punch-*.csv, optional), fields `dryRun` ('1' = preview only), `departmentStores` (JSON `{ "<department name>": "<storeId>|null" }`), `attendanceDate` (YYYY-MM-DD for the punch file; default = today).
  Returns `{ dryRun, employees:{created,updated,unchanged,rows:[{code,name,action,changes[]}]}, departments:{created[],mapped:{name:storeId|null}}, designations:{created[]}, leaveBalances:{upserted, skipped:[{code,reason}]}, attendance:{upserted, skipped:[...]}, notInSource:[{userId,name,role,storeNames}], exceptions:[{code,field,issue}] }`
  Mapping rules (from the audit's Data-Quality-Findings):
  - Match an existing User by EmployeeProfile.employeeCode, else by phone, else by case-insensitive exact name; else create a User (inactive, no password, role salesperson; STORE MANAGER → store_manager).
  - DEPARTMENT/DESIGNATION normalised case-insensitively onto ONE master row (display name = first Title-cased spelling); keep the raw row in `sourceRaw`.
  - Ignore the "Designation (personal field)" column (literal null); use DESIGNATION.
  - Dates are DD/MM/YYYY; `01/01/1900` = missing. DOC = dateOfConfirmation.
  - Emails: blank → null; do not "fix" typos, report them in `exceptions`.
  - Gender M/F. Shift column → `shiftCode`, and a ShiftAssignment to the store's shift with that `code` if one exists.
  - Leave types: `E` → `earned`, `K` → `week_off_leave`. Opening balance → `allocated`, Leave Used → `used`, year 2026.
  - Today's Punch: Present/Late with IN time → AttendanceRecord(present, isLate from file) + RawPunchEvent(kind in, source import, idempotencyKey `ezatt:<code>:<date>:in`); Absent → absent; Leave → on_leave. Never overwrite a row whose `source` is `self`/`manager`/`regularization`.
  - The import is idempotent: running it twice changes nothing the second time.
- Shift codes seeded by import when missing, per store in use: `S` 11:00–20:00, `G` 09:30–18:30, `6HR` 10:00–16:00, `F` Flexible (isFlexible, 05:00–23:00). All editable afterwards.

### Attendance operations — `attendance-ops.service.ts` + routes added to `hrms.controller.ts` (backend agent B)
- `GET /hrms/attendance/today?storeId` →
  `{ snapshotAt, stores:[{storeId,storeName,timezone,date}], denominator, counts:{present,late,half_day,absent,on_leave,week_off,holiday,not_marked}, rows:[{userId,employeeCode,name,storeId,storeName,department,designation,shift,state,isLate,lateMinutes,checkIn,checkOut,recordId}] }`
- `GET /hrms/attendance/register?from&to&storeId&userId&status` → attendance rows (existing view shape + `recordId`, `source`, `employeeCode`) — paginated `{items,total}`; replaces the "latest 200".
- `PATCH /hrms/attendance/:id` `{status?, checkIn?:"HH:MM", checkOut?:"HH:MM", shiftId?, note}` (note required) → recompute late/early/overtime/dayFraction; appends RawPunchEvent(source manager) for changed times; audit.
- `DELETE /hrms/attendance/:id` `{reason}` → deletes the register row (raw punches stay); audit.
- `GET /hrms/punches?from&to&storeId&userId` → raw punch log rows `{id,userId,name,employeeCode,storeName,kind,eventAt,local,source,lat,lng,accuracyM,note,voidedAt}`
- `POST /hrms/punches` (manager) `{userId, storeId, kind, at: ISO, note}`; `DELETE /hrms/punches/:id` → voids (sets voidedAt), never deletes.
- Every existing write path (check-in, check-out, manager mark, regularization approval, day-close auto close) ALSO appends a RawPunchEvent (idempotent key per source event).
- `POST /hrms/processing-runs` `{from,to,storeId?}` (head_office) → recompute AttendanceRecord from non-voided punches + leave + holidays + week-offs for eligible staff; skip locked months (count them); never touch rows of other stores. `GET /hrms/processing-runs` → last 20.
- `GET /hrms/payroll-locks`, `POST /hrms/payroll-locks` `{month}`, `POST /hrms/payroll-locks/:month/reopen` `{reason}` (head_office). Payslip generation for a locked month still works (it's the output); edits don't.
- `GET /hrms/approvals?status=pending` → unified inbox `[{kind:'leave'|'regularization', id, staffId, staffName, storeName, submittedAt, summary, from, to, days?, reason, status, ageHours}]`; decisions reuse the existing PATCH routes.
- `PATCH /hrms/leave/:id/edit` (manager, pending only) `{fromDate,toDate,type,halfDay,reason}`; `DELETE /hrms/leave/:id` (manager; approved leave releases balance; audit).
- `PATCH /hrms/leave/balances/:id` `{allocated?, used?, note}` (head_office); `POST /hrms/leave/balances` `{userId,type,year,allocated}`.
- Shifts: `PATCH /hrms/shifts/:id` (incl. `isFlexible`, `code`), `DELETE /hrms/shifts/:id` (409 if assigned/used today unless `?force=1` which unassigns). Holidays: `PATCH /hrms/holidays/:id`, `DELETE /hrms/holidays/:id`.
- Shift assignments: `GET /hrms/shift-assignments?userId&storeId`, `POST` `{userId, shiftId, effectiveFrom}` (closes the open one the day before), `PATCH /:id`, `DELETE /:id`. Lateness/day-close resolve the shift from the assignment effective on that date, falling back to the current behaviour.
- P0 fixes in `hrms.service.ts`: a check-IN with a confident GPS fix outside a configured fence is REFUSED even with a note (403-style 400 message); uncertain/no-fix still needs a note and goes to review; check-out outside the fence stays allowed with a note. Update the geofence tests to match.

### Analytics and reports — `attendance-analytics.service.ts` + `attendance-analytics.controller.ts` (backend agent C)
- `GET /hrms/analytics/overview?from&to&storeId&departmentId` (store_manager+) →
  `{ period:{from,to}, headcount, kpis:{attendanceRate, presentDays, absentDays, leaveDays, lateCount, avgLateMinutes, halfDays, overtimeHours, missedPunches, newJoiners, exits}, trend:[{date,present,late,absent,on_leave,week_off,holiday}], byStore:[{storeId,storeName,headcount,attendanceRate,lateCount,absentDays}], byDepartment:[...same with departmentId/name], topLate:[{userId,name,lateCount,avgLateMinutes}], topAbsent:[{userId,name,absentDays}] }`
- `GET /hrms/reports/:kind?from&to&storeId&departmentId&userId&format=json|csv` — kinds:
  `daily-register`, `muster` (employee × day grid of state codes P/L/A/LV/WO/H/HD/-), `monthly-summary` (per employee: present, late, half, absent, leave, WO, H, payable days, worked hours, OT hours), `in-out` (employee × day IN/OUT), `late-early`, `missed-punch` (in without out / out without in), `constant-absent` (`&minDays=2` consecutive), `leave-balance`, `leave-register`, `punch-log`, `gps` (punch with distance/fence/accuracy), `birthdays` (`&month`), `hiring`, `separation`, `employee-details`.
  JSON → `{ kind, columns:[{key,label}], rows:[...], totals? }`; CSV → same columns, `text/csv` attachment. Store-scoped; sensitive columns (address, blood group, DOB) only for head_office.
- Everything uses `eligibleStaff` and the same state classification as Today (import them from attendance-ops; if agent B hasn't landed yet, agree on the exported names: `eligibleStaff`, `classifyDay`, `assertMonthOpen`).

### Frontend
- `lib/queries/hrms-employees.ts`, `lib/queries/hrms-ops.ts`, `lib/queries/hrms-analytics.ts` — one per agent, react-query + `api`, types exported from the same file.
- Components under `components/hrms/`:
  - Agent D: `employees-tab.tsx` (table + filters + search, add/edit dialog with every profile field, separate/activate/purge, bulk actions, row → detail drawer), `masters-dialog.tsx` (departments with store mapping + designations CRUD), `ezattendance-import-dialog.tsx` (3 file pickers → department→store mapping step → dry-run preview with diff + exceptions + "not in source" list with bulk deactivate → apply). Also the P0 UI fixes: `components/layout/logout-dialog.tsx` — remove the "face verified"/password bypass (a captured frame is evidence, not verification); `components/attendance/auto-signout.tsx` — idle ends the app session only, it must NOT call check-out.
  - Agent E: `today-tab.tsx` (KPI tiles whose numbers sum to the denominator, status donut, per-store bar, drill-down list filtered by clicking a tile, snapshot time + timezone shown), `register-tab.tsx` (date-range register with edit/delete per row, raw punch drawer, add punch), `approvals-tab.tsx` (unified inbox, approve/reject/edit/delete), shift/holiday edit+delete + shift assignments inside the existing `shifts-schedule-tab.tsx`, leave balance edit in `leave-balances.tsx`, `payroll-lock-card.tsx` + `processing-card.tsx`, and the tab wiring in `app/(app)/hrms/page.tsx` (tabs: Today · Employees · Register · Approvals · Shifts & Schedule · Reports · Fix attendance · Late flags, role-gated as today).
  - Agent F: `analytics-tab.tsx` (period + store + department filters; KPI tiles; attendance trend stacked area; by-store bars; late/absent leaderboards) and the reports section (report picker for every kind, table view, CSV download) — replace the body of `attendance-reports-tab.tsx` rather than adding a second reports screen. Use `recharts` (already installed) and read the `dataviz` skill before charts.
- Design: follow `docs/DESIGN_SYSTEM.md` and existing HRMS components (Card, Table, Badge, Dialog, Sheet, StatTiles). Every list has empty/loading/error states. Every destructive action confirms.
- Remove the dead fake arrays from `lib/mock/hrms.ts` (ATTENDANCE_TODAY, ROSTER, LEAVE_REQUESTS, LEADERBOARD, COMMISSIONS, SHIFTS, HOLIDAYS, LATE_FLAGS, STORE_GEOFENCES) — keep the types and label maps. (Agent E.)

## Not in this build
- Biometric terminal connector and real face matching/liveness (needs a vendor and hardware).
- Private bucket for punch photos: the API already never discloses the object key; the bucket itself is still public-read (see `AttendancePhotoService`).
- Statutory payroll.
