-- AlterTable
ALTER TABLE "ReturnRecord" ADD COLUMN     "buybackValue" DECIMAL(14,2),
ADD COLUMN     "chosenOption" TEXT,
ADD COLUMN     "diaSpec" TEXT,
ADD COLUMN     "exchangeValue" DECIMAL(14,2),
ADD COLUMN     "purchaseDiaCarat" DECIMAL(10,3),
ADD COLUMN     "purchaseDiaRate" DECIMAL(12,2),
ADD COLUMN     "purchaseGoldRate" DECIMAL(12,2),
ADD COLUMN     "purchaseGoldWtG" DECIMAL(12,3),
ADD COLUMN     "purchaseMaking" DECIMAL(14,2),
ADD COLUMN     "todayDiaRate" DECIMAL(12,2),
ADD COLUMN     "todayGoldRate" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "DiamondRate" (
    "id" TEXT NOT NULL,
    "spec" TEXT NOT NULL,
    "ratePerCarat" DECIMAL(12,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "storeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiamondRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DiamondRate_spec_effectiveFrom_idx" ON "DiamondRate"("spec", "effectiveFrom");
