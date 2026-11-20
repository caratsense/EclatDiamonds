-- Low-stock alerts (the 9 Oct list, item 16's other half): until now the
-- Reorder tab could only carry a request somebody had already decided to raise.
-- Nothing told a branch that a design it sells had run out.
--
-- The level is the tenant's default with a per-design override; the alert row
-- is the de-duplication, so a branch is told once per design and not again
-- until it has recovered.

ALTER TYPE "NotificationKind" ADD VALUE 'low_stock' AFTER 'lead_assigned';

ALTER TABLE "Product" ADD COLUMN "reorderLevel" INTEGER;

CREATE TABLE "LowStockAlert" (
    "organisationId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "onHand" INTEGER NOT NULL,
    "firstAlertedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "LowStockAlert_pkey" PRIMARY KEY ("id")
);

-- One row per design per branch: reopened on the next shortfall rather than
-- duplicated, which is also what makes two replicas sweeping at once safe.
CREATE UNIQUE INDEX "LowStockAlert_productId_storeId_key" ON "LowStockAlert"("productId", "storeId");

CREATE INDEX "LowStockAlert_organisationId_resolvedAt_idx" ON "LowStockAlert"("organisationId", "resolvedAt");

ALTER TABLE "LowStockAlert" ADD CONSTRAINT "LowStockAlert_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LowStockAlert" ADD CONSTRAINT "LowStockAlert_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LowStockAlert" ADD CONSTRAINT "LowStockAlert_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
