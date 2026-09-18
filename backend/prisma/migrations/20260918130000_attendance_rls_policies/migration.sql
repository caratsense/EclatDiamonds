-- Row-level security policies for the attendance tables added in
-- 20260918120000_employee_master_and_punch_ledger, in the same style as
-- 20260903130000_caratos_b3_rls_policies: policies are CREATED and RLS is left
-- DISABLED, so query behaviour is unchanged. Enabling is the separate, deliberate
-- step described in that migration. All seven carry a non-nullable organisationId.

DROP POLICY IF EXISTS "AttendanceProcessingRun_tenant_isolation" ON "AttendanceProcessingRun";
CREATE POLICY "AttendanceProcessingRun_tenant_isolation" ON "AttendanceProcessingRun"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "AttendanceProcessingRun" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Department_tenant_isolation" ON "Department";
CREATE POLICY "Department_tenant_isolation" ON "Department"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "Department" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Designation_tenant_isolation" ON "Designation";
CREATE POLICY "Designation_tenant_isolation" ON "Designation"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "Designation" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "EmployeeProfile_tenant_isolation" ON "EmployeeProfile";
CREATE POLICY "EmployeeProfile_tenant_isolation" ON "EmployeeProfile"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "EmployeeProfile" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "PayrollPeriodLock_tenant_isolation" ON "PayrollPeriodLock";
CREATE POLICY "PayrollPeriodLock_tenant_isolation" ON "PayrollPeriodLock"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "PayrollPeriodLock" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "RawPunchEvent_tenant_isolation" ON "RawPunchEvent";
CREATE POLICY "RawPunchEvent_tenant_isolation" ON "RawPunchEvent"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "RawPunchEvent" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ShiftAssignment_tenant_isolation" ON "ShiftAssignment";
CREATE POLICY "ShiftAssignment_tenant_isolation" ON "ShiftAssignment"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "ShiftAssignment" DISABLE ROW LEVEL SECURITY;

