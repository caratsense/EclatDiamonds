-- Payment reversal entries (Module 12) — immutable original + signed reversal. Additive.
-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "reversalReason" TEXT,
ADD COLUMN     "reversesPaymentId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Payment_reversesPaymentId_key" ON "Payment"("reversesPaymentId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_reversesPaymentId_fkey" FOREIGN KEY ("reversesPaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
