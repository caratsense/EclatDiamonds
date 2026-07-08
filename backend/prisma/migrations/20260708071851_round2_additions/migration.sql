-- CreateEnum
CREATE TYPE "QuoteKind" AS ENUM ('sale', 'repair');

-- AlterTable
ALTER TABLE "CustomOrder" ADD COLUMN     "advanceMode" TEXT,
ADD COLUMN     "advanceReceiptUrl" TEXT,
ADD COLUMN     "bangleSize" TEXT,
ADD COLUMN     "deliveryDate" DATE,
ADD COLUMN     "metalColor" TEXT,
ADD COLUMN     "ringSize" TEXT;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "address" TEXT,
ADD COLUMN     "anniversary" DATE,
ADD COLUMN     "birthday" DATE;

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "grossWeightG" DECIMAL(10,3),
ADD COLUMN     "kind" "QuoteKind" NOT NULL DEFAULT 'sale',
ADD COLUMN     "remarks" TEXT;

-- AlterTable
ALTER TABLE "Referral" ADD COLUMN     "billDate" DATE,
ADD COLUMN     "invoiceNo" TEXT;

-- AlterTable
ALTER TABLE "ReferralPayout" ADD COLUMN     "invoiceNo" TEXT;

-- AlterTable
ALTER TABLE "ReturnRecord" ADD COLUMN     "entryMode" TEXT DEFAULT 'manual',
ADD COLUMN     "invoiceNo" TEXT;

-- CreateTable
CREATE TABLE "QuotePhoto" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuotePhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuotePhoto_quoteId_idx" ON "QuotePhoto"("quoteId");

-- AddForeignKey
ALTER TABLE "QuotePhoto" ADD CONSTRAINT "QuotePhoto_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
