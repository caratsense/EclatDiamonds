-- CreateEnum
CREATE TYPE "OrderKind" AS ENUM ('custom', 'stock');

-- AlterTable
ALTER TABLE "CustomOrder" ADD COLUMN     "advanceReceived" DECIMAL(14,2),
ADD COLUMN     "category" "ProductCategory",
ADD COLUMN     "details" TEXT,
ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "kind" "OrderKind" NOT NULL DEFAULT 'custom',
ADD COLUMN     "qty" INTEGER NOT NULL DEFAULT 1;
