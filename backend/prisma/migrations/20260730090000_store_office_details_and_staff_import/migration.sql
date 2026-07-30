-- Office address + contact for each branch, imported from the legacy PartyMst
-- branch row (FirmAdd1-3 / FirmCity / FirmState / PinCode / FirmTele / FirmEmail
-- / AccGst). Nullable throughout: a branch may legitimately have none of it, and
-- the sync must never fail because one field is blank.
--
-- Note there is deliberately NO latitude/longitude here — those columns already
-- exist on Store, and the legacy system holds no coordinates at all, so they stay
-- a manual/geocoded step rather than something the sync can fill.
ALTER TABLE "Store" ADD COLUMN     "addressLine1" TEXT,
ADD COLUMN     "addressLine2" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "gstin" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "pincode" TEXT,
ADD COLUMN     "state" TEXT;

-- Legacy provenance for imported staff. Imported users arrive inactive with no
-- passwordHash, so this unique index is what makes re-running the import an
-- update of the same person rather than a duplicate.
ALTER TABLE "User" ADD COLUMN     "legacyId" TEXT,
ADD COLUMN     "legacyUpdatedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "User_legacyId_key" ON "User"("legacyId");
