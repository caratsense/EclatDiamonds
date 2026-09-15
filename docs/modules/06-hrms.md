# Module 6 — HRMS & Attendance (Zoho-People-informed)

> Client parked HRMS in round-2 to first study **Zoho People**. This is the
> Zoho-informed design we're building. Scope adapted to Eclat: multi-store
> jewelry retail, 3–5 staff/store, **phone-GPS attendance (NOT face-scan)**.

## What we borrow from Zoho People
Researched from Zoho People's attendance + leave docs:
- **Attendance:** web/mobile **check-in AND check-out**, **GPS geo-fencing** (punch
  valid only inside the location's radius), location captured at punch, **shifts**
  with lenient/strict margins. *(Zoho also offers a face-recognition kiosk — client
  explicitly rejected face-scan, so we do phone-GPS only.)*
- **Leave:** configurable **leave types**, **balances with accrual** (opening balance
  + annual quota + cap), **regularization** (convert an absence / fix a missed punch),
  **single/multi-level approval workflow**.

## What already existed in Eclat (reuse, don't rebuild)
- `Store.latitude/longitude/geofenceRadiusM(150)/weekOffDay` — geofence scaffold. ✅
- `AttendanceRecord`: `checkInAt/checkOutAt/checkInLat/checkInLng/geoVerified/shiftId/isLate/lateMinutes`. ✅
- `Shift` (start/end/buffer/nightBatch), `StoreHoliday`, `LeaveRequest` (enum type/status/from/to), `Commission` (userId/period/salesValue/rate/amount). ✅
- Existing admin "mark attendance", leave request + approve, leaderboard, commission, shifts, week-off, holidays, late-flags (3×/mo).

## What we ADD (the Zoho gap)

### A. Self-service phone geo check-in / check-out  `NEW`
- The **employee** punches from their own phone (browser geolocation), not an admin.
- `POST /hrms/attendance/check-in {lat,lng,shiftId?}` → haversine distance to the
  employee's store; `withinFence = distance ≤ geofenceRadiusM`. **Lenient by default**:
  always records, flags `geoVerified` + `checkInDistanceM`; UI shows green "within range"
  / amber "outside (Xm)". Late computed vs assigned shift start + buffer.
- `POST /hrms/attendance/check-out {lat,lng}` → sets `checkOutAt` + `checkOutLat/Lng` +
  `workedMins`.
- `GET /hrms/attendance/me?month=YYYY-MM` → my punches + today's state.
- Schema add: `AttendanceRecord.checkOutLat/checkOutLng/checkInDistanceM/workedMins`.

### B. Leave management with balances  `NEW`
- `LeaveBalance(userId, storeId?, type, year, allocated, used)` — per staff, per type, per year.
- Default annual allocation (seeded): **Casual 12, Sick 6, Earned/Privileged 15, Unpaid ∞**.
  1 week-off/week stays a store policy (`Store.weekOffDay`), separate from leave.
- Apply: `POST /hrms/leave {type, fromDate, toDate, days, halfDay?, reason}` (days auto-computed,
  excludes weekly-off + holidays). Approve decrements `used`; reject restores. Balance guard.
- `GET /hrms/leave/balances?staffId=` (self = own; manager = team).
- Schema add: `LeaveRequest.days/halfDay`.

### C. Attendance regularization  `NEW`
- `AttendanceRegularization(storeId, staffId, date, requestedCheckIn?, requestedCheckOut?, reason, status)`.
- Employee requests a fix for a missed/wrong punch → manager approves → the
  AttendanceRecord is corrected. Endpoints: create / list / approve / reject.

### D. Editable commission rate  `CHANGED`
- `PATCH /hrms/commission/:id {rate}` → recompute `amount = salesValue × rate%`.
  (round-2: "commission rate must be editable — currently isn't".)

### E. Move Leaderboard + Commission to **Sales**  `CHANGED`
- round-2: leaderboard/commission are sales artifacts, not HR. Surface them on a new
  **Sales → Sales Performance** page (reusing the existing leaderboard + commission
  endpoints); remove those two tabs from the HRMS page.

## Roles
- Punch/regularize/apply-leave: **any staff** (self, store-scoped).
- Approve leave/regularization, edit commission, set shifts/week-off/holidays: **store_manager+**.
- Cross-store views: **area_manager / head_office**.

## Deferred (note, don't build now)
- Multi-level approval chains, leave carry-forward/accrual schedules, IP restriction,
  shift rotation automation, biometric/face kiosk.
- Payroll/payslips is no longer deferred (2026-09-12/15): week-offs, compensation,
  payslip drafts and the month-end run log live on `/hrms/payroll` (API
  `/hrms/payroll/week-offs`, `/hrms/payroll/payslips`, `/hrms/payroll/runs`).
  Statutory deductions (PF/ESI/PT/TDS) are not computed — that policy is the client's.
