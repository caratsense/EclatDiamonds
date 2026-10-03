-- A lead that has just been routed needs to reach the person who must act on
-- it. Postgres enum values cannot be added inside a transaction that also uses
-- them, so this migration only widens the type; nothing reads the new value
-- until the application code that emits it is deployed.
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'lead_assigned';
