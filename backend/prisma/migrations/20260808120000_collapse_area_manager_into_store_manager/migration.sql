-- Collapse the area_manager tier into store_manager (2026-08).
--
-- The area manager role was folded into store_manager: store managers now hold
-- the operational authority the area manager used to (production, finance view,
-- targets, store setup, discount cost/margin, etc.), and area_manager is no
-- longer a role anyone signs up as. Reassign every LIVE user (active and pending
-- signups) from area_manager to store_manager.
--
-- The `area_manager` enum value is intentionally NOT dropped: historical audit
-- rows, notifications and any other references that recorded the string stay
-- valid. Dropping an enum value is destructive and unnecessary here.
--
-- Idempotent + safe: a no-op where there are no area managers (e.g. production
-- today, which has only head office + the sync account).

UPDATE "User" SET "role" = 'store_manager' WHERE "role" = 'area_manager';
UPDATE "User" SET "requestedRole" = 'store_manager' WHERE "requestedRole" = 'area_manager';
