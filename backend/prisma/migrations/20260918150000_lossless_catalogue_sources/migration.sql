-- Lossless website + Gati catalogue: source snapshots, website listing, variants,
-- options (sizes), labelled prices, image provenance/lifecycle/embedding state,
-- image associations, sync runs and the conflict queue. Additive only; every
-- new column is nullable or defaulted, so the previous build keeps working.
-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "gatiSyncedAt" TIMESTAMP(3),
ADD COLUMN     "hsn" TEXT,
ADD COLUMN     "websiteSyncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ProductImage" ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "embeddedAt" TIMESTAMP(3),
ADD COLUMN     "embeddingAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "embeddingError" TEXT,
ADD COLUMN     "embeddingStatus" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN     "embeddingVersion" TEXT,
ADD COLUMN     "height" INTEGER,
ADD COLUMN     "pinnedPrimary" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'other',
ADD COLUMN     "sourceImageId" TEXT,
ADD COLUMN     "sourceOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sourceUrl" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "thumbUrl" TEXT,
ADD COLUMN     "tombstonedAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "width" INTEGER;

-- AlterTable
ALTER TABLE "StockItem" ADD COLUMN     "hsn" TEXT,
ADD COLUMN     "itemSizeId" TEXT,
ADD COLUMN     "productCode" TEXT,
ADD COLUMN     "quantity" INTEGER,
ADD COLUMN     "sizeLabel" TEXT,
ADD COLUMN     "stonePieces" INTEGER,
ADD COLUMN     "variantId" TEXT;

-- CreateTable
CREATE TABLE "ExternalProductSnapshot" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "productCode" TEXT,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "goneAt" TIMESTAMP(3),
    "syncRunId" TEXT,
    "normalizationStatus" TEXT NOT NULL DEFAULT 'ok',
    "normalizationError" TEXT,
    "productId" TEXT,

    CONSTRAINT "ExternalProductSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductWebsiteListing" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "marketingName" TEXT NOT NULL,
    "slug" TEXT,
    "categories" TEXT[],
    "subCategories" TEXT[],
    "features" TEXT[],
    "tags" TEXT[],
    "countries" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "specifications" TEXT,
    "sizeGuide" TEXT,
    "seo" JSONB,
    "sourceCreatedAt" TIMESTAMP(3),
    "sourceUpdatedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tombstonedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductWebsiteListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sku" TEXT,
    "metalType" TEXT,
    "karat" INTEGER,
    "metal" "MetalKind",
    "diamondType" TEXT,
    "colour" TEXT,
    "weightType" TEXT,
    "goldWeight" DECIMAL(12,3),
    "diamondWeight" DECIMAL(10,3),
    "stoneWeight" DECIMAL(10,3),
    "totalWeight" DECIMAL(12,3),
    "price" DECIMAL(14,2),
    "priceWithMargin" DECIMAL(14,2),
    "marginPercentage" DECIMAL(6,2),
    "makingCharge" DECIMAL(14,2),
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "bom" JSONB,
    "attributes" JSONB,
    "status" TEXT NOT NULL DEFAULT 'active',
    "tombstonedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductOption" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "tombstonedAt" TIMESTAMP(3),

    CONSTRAINT "ProductOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductPrice" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantKey" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductImageAssociation" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "imageId" TEXT NOT NULL,
    "variantId" TEXT,
    "source" TEXT NOT NULL,
    "colour" TEXT NOT NULL DEFAULT '',
    "shape" TEXT NOT NULL DEFAULT '',
    "angle" TEXT,
    "sourceOrder" INTEGER NOT NULL DEFAULT 0,
    "tombstonedAt" TIMESTAMP(3),

    CONSTRAINT "ProductImageAssociation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogueSyncRun" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'full',
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'running',
    "nextPage" INTEGER NOT NULL DEFAULT 1,
    "pageSize" INTEGER NOT NULL DEFAULT 100,
    "expected" INTEGER,
    "received" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "tombstoned" INTEGER NOT NULL DEFAULT 0,
    "conflicted" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "imagesExpected" INTEGER NOT NULL DEFAULT 0,
    "imagesReceived" INTEGER NOT NULL DEFAULT 0,
    "imagesQueued" INTEGER NOT NULL DEFAULT 0,
    "detail" JSONB,
    "lastError" TEXT,
    "startedById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CatalogueSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogueConflict" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "productId" TEXT,
    "externalId" TEXT,
    "summary" TEXT NOT NULL,
    "detail" JSONB,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" JSONB,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogueConflict_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalProductSnapshot_organisationId_source_productCode_idx" ON "ExternalProductSnapshot"("organisationId", "source", "productCode");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalProductSnapshot_organisationId_source_externalId_key" ON "ExternalProductSnapshot"("organisationId", "source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductWebsiteListing_productId_key" ON "ProductWebsiteListing"("productId");

-- CreateIndex
CREATE INDEX "ProductWebsiteListing_organisationId_productCode_idx" ON "ProductWebsiteListing"("organisationId", "productCode");

-- CreateIndex
CREATE INDEX "ProductVariant_organisationId_idx" ON "ProductVariant"("organisationId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_productId_source_sourceKey_key" ON "ProductVariant"("productId", "source", "sourceKey");

-- CreateIndex
CREATE INDEX "ProductOption_organisationId_kind_value_idx" ON "ProductOption"("organisationId", "kind", "value");

-- CreateIndex
CREATE UNIQUE INDEX "ProductOption_productId_source_kind_value_key" ON "ProductOption"("productId", "source", "kind", "value");

-- CreateIndex
CREATE INDEX "ProductPrice_organisationId_kind_amount_idx" ON "ProductPrice"("organisationId", "kind", "amount");

-- CreateIndex
CREATE UNIQUE INDEX "ProductPrice_productId_variantKey_source_kind_key" ON "ProductPrice"("productId", "variantKey", "source", "kind");

-- CreateIndex
CREATE INDEX "ProductImageAssociation_organisationId_idx" ON "ProductImageAssociation"("organisationId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductImageAssociation_imageId_source_colour_shape_sourceO_key" ON "ProductImageAssociation"("imageId", "source", "colour", "shape", "sourceOrder");

-- CreateIndex
CREATE INDEX "CatalogueSyncRun_organisationId_source_startedAt_idx" ON "CatalogueSyncRun"("organisationId", "source", "startedAt");

-- CreateIndex
CREATE INDEX "CatalogueConflict_organisationId_status_idx" ON "CatalogueConflict"("organisationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogueConflict_organisationId_kind_key_key" ON "CatalogueConflict"("organisationId", "kind", "key");

-- CreateIndex
CREATE INDEX "ProductImage_organisationId_embeddingStatus_idx" ON "ProductImage"("organisationId", "embeddingStatus");

-- CreateIndex
CREATE INDEX "ProductImage_productId_contentHash_idx" ON "ProductImage"("productId", "contentHash");

-- AddForeignKey
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalProductSnapshot" ADD CONSTRAINT "ExternalProductSnapshot_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductWebsiteListing" ADD CONSTRAINT "ProductWebsiteListing_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductWebsiteListing" ADD CONSTRAINT "ProductWebsiteListing_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductOption" ADD CONSTRAINT "ProductOption_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductOption" ADD CONSTRAINT "ProductOption_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPrice" ADD CONSTRAINT "ProductPrice_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPrice" ADD CONSTRAINT "ProductPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImageAssociation" ADD CONSTRAINT "ProductImageAssociation_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImageAssociation" ADD CONSTRAINT "ProductImageAssociation_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "ProductImage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImageAssociation" ADD CONSTRAINT "ProductImageAssociation_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogueSyncRun" ADD CONSTRAINT "CatalogueSyncRun_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogueConflict" ADD CONSTRAINT "CatalogueConflict_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Existing pictures of website-imported designs are website photographs.
UPDATE "ProductImage" i SET "source" = 'website' FROM "Product" p WHERE p."id" = i."productId" AND p."legacyId" LIKE 'WEB-%';

-- Tenant isolation policies, written like b3 (not enabled).
DROP POLICY IF EXISTS "ExternalProductSnapshot_tenant_isolation" ON "ExternalProductSnapshot";
CREATE POLICY "ExternalProductSnapshot_tenant_isolation" ON "ExternalProductSnapshot"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "ExternalProductSnapshot" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ProductWebsiteListing_tenant_isolation" ON "ProductWebsiteListing";
CREATE POLICY "ProductWebsiteListing_tenant_isolation" ON "ProductWebsiteListing"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "ProductWebsiteListing" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ProductVariant_tenant_isolation" ON "ProductVariant";
CREATE POLICY "ProductVariant_tenant_isolation" ON "ProductVariant"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "ProductVariant" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ProductOption_tenant_isolation" ON "ProductOption";
CREATE POLICY "ProductOption_tenant_isolation" ON "ProductOption"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "ProductOption" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ProductPrice_tenant_isolation" ON "ProductPrice";
CREATE POLICY "ProductPrice_tenant_isolation" ON "ProductPrice"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "ProductPrice" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ProductImageAssociation_tenant_isolation" ON "ProductImageAssociation";
CREATE POLICY "ProductImageAssociation_tenant_isolation" ON "ProductImageAssociation"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "ProductImageAssociation" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "CatalogueSyncRun_tenant_isolation" ON "CatalogueSyncRun";
CREATE POLICY "CatalogueSyncRun_tenant_isolation" ON "CatalogueSyncRun"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "CatalogueSyncRun" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "CatalogueConflict_tenant_isolation" ON "CatalogueConflict";
CREATE POLICY "CatalogueConflict_tenant_isolation" ON "CatalogueConflict"
  USING (caratos_platform_bypass() OR "organisationId" = caratos_current_org())
  WITH CHECK (caratos_platform_bypass() OR "organisationId" = caratos_current_org());
ALTER TABLE "CatalogueConflict" DISABLE ROW LEVEL SECURITY;

