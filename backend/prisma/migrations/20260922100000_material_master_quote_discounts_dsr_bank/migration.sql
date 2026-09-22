-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "additionalDiscount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "makingDiscountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "stoneDiscountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "QuoteLine" ADD COLUMN     "makingRatePerGram" DECIMAL(12,2),
ADD COLUMN     "metalCode" TEXT,
ADD COLUMN     "size" TEXT,
ADD COLUMN     "stones" JSONB,
ADD COLUMN     "styleNumber" TEXT;

-- AlterTable
ALTER TABLE "DailyReport" ADD COLUMN     "customBankTransfer" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "remark" TEXT;

-- CreateTable
CREATE TABLE "Material" (
    "organisationId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "groupCode" TEXT,
    "groupName" TEXT,
    "karat" INTEGER,
    "tone" TEXT,
    "shape" TEXT,
    "quality" TEXT,
    "saleRates" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "legacyId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialSize" (
    "organisationId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "mm" TEXT,
    "caratPerPiece" DECIMAL(8,4),
    "sizeGroup" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "legacyId" TEXT,

    CONSTRAINT "MaterialSize_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StyleBom" (
    "organisationId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "styleCode" TEXT NOT NULL,
    "itemType" TEXT,
    "itemSize" TEXT,
    "lines" JSONB NOT NULL,
    "legacyId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StyleBom_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Material_organisationId_kind_idx" ON "Material"("organisationId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Material_organisationId_kind_code_key" ON "Material"("organisationId", "kind", "code");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialSize_organisationId_code_key" ON "MaterialSize"("organisationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "StyleBom_organisationId_styleCode_key" ON "StyleBom"("organisationId", "styleCode");

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialSize" ADD CONSTRAINT "MaterialSize_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StyleBom" ADD CONSTRAINT "StyleBom_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Quotes priced before this gave one % off making + stones. Carry it into both,
-- so re-pricing an old quote comes to the same discount.
UPDATE "Quote" SET "makingDiscountPercent" = "discountPercent", "stoneDiscountPercent" = "discountPercent" WHERE "discountPercent" <> 0;

-- Tenant policies for the three new tables, created and left DISABLED like
-- 20260918130000_attendance_rls_policies.
DROP POLICY IF EXISTS "Material_tenant_isolation" ON "Material";
CREATE POLICY "Material_tenant_isolation" ON "Material"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "Material" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "MaterialSize_tenant_isolation" ON "MaterialSize";
CREATE POLICY "MaterialSize_tenant_isolation" ON "MaterialSize"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "MaterialSize" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "StyleBom_tenant_isolation" ON "StyleBom";
CREATE POLICY "StyleBom_tenant_isolation" ON "StyleBom"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "StyleBom" DISABLE ROW LEVEL SECURITY;
