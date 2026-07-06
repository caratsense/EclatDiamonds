-- AlterTable
ALTER TABLE "DiscountLimit" ADD COLUMN     "maxDiamondPercent" DECIMAL(5,2),
ADD COLUMN     "maxMakingPercent" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "DiscountRequest" ADD COLUMN     "costPrice" DECIMAL(14,2),
ADD COLUMN     "diamondPercent" DECIMAL(5,2),
ADD COLUMN     "makingPercent" DECIMAL(5,2),
ADD COLUMN     "requiredRole" "Role",
ADD COLUMN     "sellingPrice" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "costPrice" DECIMAL(14,2);
