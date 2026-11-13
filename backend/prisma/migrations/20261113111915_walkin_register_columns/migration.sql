-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CheckinPurpose" ADD VALUE 'purchase';
ALTER TYPE "CheckinPurpose" ADD VALUE 'return_exchange';

-- AlterEnum
ALTER TYPE "CheckinOutcome" ADD VALUE 'custom_order';

-- AlterTable
ALTER TABLE "CheckIn" ADD COLUMN     "deliveryDate" DATE,
ADD COLUMN     "googleReviewTaken" BOOLEAN,
ADD COLUMN     "managerName" TEXT,
ADD COLUMN     "npsMessageSentAt" TIMESTAMP(3),
ADD COLUMN     "npsResponseReceivedAt" TIMESTAMP(3),
ADD COLUMN     "recommendedAction" TEXT,
ADD COLUMN     "referralName" TEXT,
ADD COLUMN     "referralPhone" TEXT,
ADD COLUMN     "visitDate" DATE;

