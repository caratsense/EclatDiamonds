-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "receiptUrl" TEXT;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "advanceReceived" DECIMAL(14,2),
ADD COLUMN     "customerName" TEXT,
ADD COLUMN     "invoiceUrl" TEXT,
ADD COLUMN     "isManual" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paymentMode" "PaymentMode",
ADD COLUMN     "quotationUrl" TEXT;
