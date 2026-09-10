-- CaratOS Phase 2B — organisation-scope the app-created identifier uniques.
-- Converts global single-column uniques to (organisationId, key) composites so a
-- second tenant can own the same SKU / preset code / referral code / discount-cap
-- key without colliding with Eclat. Safe: existing rows are all org 'org_eclat'
-- with already-unique keys, so no duplicate can arise on create.
-- (Gati-provenance `legacyId` uniques are intentionally NOT changed here — they
--  move with the sync/connector phase. Two unrelated pre-existing drift DROP INDEX
--  statements Prisma proposed were excluded to keep this migration scoped.)

DROP INDEX "DiscountLimit_role_storeId_key";
DROP INDEX "DiscountPreset_code_key";
DROP INDEX "Product_sku_key";
DROP INDEX "ReferralCode_code_key";

CREATE UNIQUE INDEX "DiscountLimit_organisationId_role_storeId_key" ON "DiscountLimit"("organisationId", "role", "storeId");
CREATE UNIQUE INDEX "DiscountPreset_organisationId_code_key" ON "DiscountPreset"("organisationId", "code");
CREATE UNIQUE INDEX "Product_organisationId_sku_key" ON "Product"("organisationId", "sku");
CREATE UNIQUE INDEX "ReferralCode_organisationId_code_key" ON "ReferralCode"("organisationId", "code");
