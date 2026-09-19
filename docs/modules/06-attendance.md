# Module 6 — Dashboard-native attendance

Status: implemented locally on 2026-09-18. This document describes the shipped
contract, not a future build plan.

## Product decision

CaratOS is the attendance system of record. Staff and managers use the CaratOS
dashboard/mobile web application; a biometric terminal, vendor cloud, facial
recognition or liveness provider is not required.

- Staff punch in/out from `/check-in` or the HRMS dashboard.
- Browser GPS enforces a configured branch geofence on the server.
- A camera image is optional evidence only. It is never called identity or face
  verification and never unlocks login or attendance.
- `biometricNo` remains only as an optional **Legacy attendance ID** so an old
  EzAttendance export can be reconciled during migration.
- EzAttendance CSV import is a one-time optional migration tool, not a runtime
  dependency.

## What is implemented

### Staff

- Password/OTP application login without fake face-login state.
- Self check-in and check-out with store-local date/time, GPS accuracy,
  geofence result, optional reason and optional photo.
- A confident out-of-fence check-in is blocked. Missing or uncertain GPS needs
  a reason. Out-of-fence checkout is allowed with a reason so staff cannot be
  trapped in an open shift.
- Concurrent browser tabs cannot create duplicate check-ins/check-outs.
- Own leave balance, leave request history and pending-request withdrawal.
- Idle application logout does not silently create an attendance checkout.

### Managers and head office

- Today view, employee master, attendance register, raw punch ledger, unified
  leave/regularisation approvals, shifts, effective-dated assignments,
  holidays, weekly offs, payroll locks, processing runs and attendance fixes.
- Add/void punches and attendance corrections are transactional, audited and
  reprocess the daily register from the surviving ledger.
- Deleting a register record first voids its live punches, preventing a later
  processing run from resurrecting the deleted attendance.
- Regularisation approval/rejection is claimed transactionally, so concurrent
  reviewers cannot decide the same request twice.
- Store/role boundaries apply to employee, shift, weekly-off and compensation
  operations. Locked payroll months refuse historical mutation.
- A manager cannot mark a future day or attach punch times to absent/leave/
  weekly-off/holiday states.

### Calculation integrity

- Attendance uses the branch timezone and rejects impossible or ambiguous
  local wall-clock times around daylight-saving transitions.
- Each computed row stores `calculationVersion` and a shift snapshot. Later
  shift edits therefore do not silently rewrite the explanation of an old row.
- Raw punch idempotency is unique per tenant, not globally across all clients.
- Flexible shifts never accrue lateness or early-out.
- Week-off changes are blocked only when the affected current payroll month is
  locked; old locked months do not freeze the employee's roster forever.

### Reports and media

- Attendance analytics and operational reports remain store scoped.
- Reports download as CSV, real XLSX workbooks and multipage printable PDF.
- Attendance photos are encrypted with AES-256-GCM before local/R2 storage and
  bound to the organisation as authenticated data. Download requires an
  authenticated, tenant-scoped route; catalogue/public objects are unaffected.
- Production fails closed for new attendance photos when
  `ATTENDANCE_MEDIA_KEY` is absent. A punch still succeeds because a photo is
  optional evidence.

## Deployment requirement

Set a stable, environment-specific `ATTENDANCE_MEDIA_KEY` containing exactly
32 bytes encoded as base64 or hex. Do not casually rotate it: existing encrypted
photos require the old key until a versioned re-encryption migration exists.

Run the additive migration
`20260918160000_attendance_dashboard_hardening` and regenerate Prisma before
deployment.

## Deliberately outside this module

- External biometric/device integration and real facial recognition.
- Statutory payroll, PF, ESI, TDS or bank files; current payslips are pre-tax.
- Scheduled attendance report email delivery. Interactive CSV/XLSX/PDF exports
  are complete, but the existing scheduled-report engine is lead-report-only
  and must not be described as attendance scheduling.
- Database RLS activation. Policies exist platform-wide, but enabling them is a
  platform decision that first requires per-request tenant context for every
  connection.

## Verification baseline

- Prisma schema validates and the database migrates from zero through all 117
  migrations.
- Backend and frontend TypeScript compile cleanly.
- Focused HRMS, payroll, geofence, photo-encryption and export tests pass.
- The shared browser geofence policy has dedicated frontend unit tests.
