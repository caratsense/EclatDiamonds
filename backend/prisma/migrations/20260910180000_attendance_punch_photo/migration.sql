-- A photo taken at the moment of the punch.
--
-- Additive and nullable: every existing row stays valid and every existing
-- punch keeps working without one. Rolling back is
--   ALTER TABLE "AttendanceRecord"
--     DROP COLUMN "checkInPhotoUrl", DROP COLUMN "checkOutPhotoUrl";
--
-- These hold a storage URL, never image bytes: the object lives in the tenant's
-- namespaced prefix in object storage, and the database keeps a pointer. A photo
-- column in Postgres is a photo in every backup, every replica and every dump.
--
-- Deliberately NOT a "biometric match" or a confidence score. Nothing in this
-- system compares a face to an enrolled template, so a column claiming a
-- verified identity would be a record that lies. What is true is that a camera
-- on the device produced this image at punch time, which is what a manager
-- reviewing a suspicious punch actually needs alongside the existing geofence
-- distance and mock-location flag.
ALTER TABLE "AttendanceRecord" ADD COLUMN "checkInPhotoUrl" TEXT;
ALTER TABLE "AttendanceRecord" ADD COLUMN "checkOutPhotoUrl" TEXT;
