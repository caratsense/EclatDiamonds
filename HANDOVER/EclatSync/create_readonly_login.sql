-- ============================================================================
-- Eclat / CaratSense — least-privilege READ-ONLY login for the sync agent.
--
-- Run this ONCE on the client's SQL Server, as an admin, in SSMS (New Query).
-- It creates a dedicated account the sync uses. That account can ONLY read:
-- it is physically unable to INSERT / UPDATE / DELETE or change any schema.
--
-- IMPORTANT: this script does NOT read, move, or modify any business data.
-- It only DEFINES a safe account. Your sales/stock/customers are never touched.
--
-- Before running, take a normal backup of the database (standard precaution).
-- ============================================================================

-- ---- 1) Server-level login.  CHANGE the password below. ----
USE [master];
GO
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'eclat_readonly')
BEGIN
    CREATE LOGIN [eclat_readonly]
        WITH PASSWORD = N'CHANGE_THIS_TO_A_STRONG_PASSWORD',
             CHECK_POLICY = ON,
             DEFAULT_DATABASE = [APRSSJEP];   -- change if the DB name differs
END
GO

-- ---- 2) Map the login into the APRS-SJEP database. ----
USE [APRSSJEP];   -- <<< change to the real database name if different
GO
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'eclat_readonly')
BEGIN
    CREATE USER [eclat_readonly] FOR LOGIN [eclat_readonly];
END
GO

-- ---- 3) Grant ONLY read, then explicitly DENY every write (belt + suspenders). ----
ALTER ROLE [db_datareader] ADD MEMBER [eclat_readonly];   -- SELECT on all tables
GO
DENY INSERT, UPDATE, DELETE, EXECUTE, ALTER, CONTROL TO [eclat_readonly];
GO

-- ---- 4) Verify (optional): should show db_datareader and no write roles. ----
SELECT dp.name AS account, r.name AS role_granted
FROM sys.database_role_members m
JOIN sys.database_principals dp ON dp.principal_id = m.member_principal_id
JOIN sys.database_principals r  ON r.principal_id  = m.role_principal_id
WHERE dp.name = N'eclat_readonly';
GO

-- After this runs, the agent connects with:
--   SJEP_SQL_USER = eclat_readonly
--   SJEP_SQL_PASS = (the password you set above)
-- ============================================================================
