-- Module 15 direct-sale discount control + soft-void metadata (additive, nullable).
-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "diamondDiscountPercent" DECIMAL(5,2),
ADD COLUMN     "diamondValue" DECIMAL(14,2),
ADD COLUMN     "discountRequestId" TEXT,
ADD COLUMN     "makingDiscountPercent" DECIMAL(5,2),
ADD COLUMN     "makingValue" DECIMAL(14,2);

-- CreateIndex
CREATE UNIQUE INDEX "Sale_discountRequestId_key" ON "Sale"("discountRequestId");

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_discountRequestId_fkey" FOREIGN KEY ("discountRequestId") REFERENCES "DiscountRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
