-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "lostReason" TEXT,
ADD COLUMN     "outcome" TEXT NOT NULL DEFAULT 'open';

-- AlterTable
ALTER TABLE "LeadNote" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'note';
