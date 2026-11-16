-- AlterEnum
ALTER TYPE "SpecialRequestKind" ADD VALUE 'customer_deletion';

-- AlterTable
ALTER TABLE "SpecialRequest" ADD COLUMN     "partyId" TEXT;

-- AddForeignKey
ALTER TABLE "SpecialRequest" ADD CONSTRAINT "SpecialRequest_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

