-- Module 9 — stock-entry HUID + manual "Adjust status" outcomes. Fully additive.

-- AlterEnum: new manual-adjustment statuses (each is the target of a mandatory reason).
ALTER TYPE "StockStatus" ADD VALUE 'damaged';
ALTER TYPE "StockStatus" ADD VALUE 'lost';
ALTER TYPE "StockStatus" ADD VALUE 'vendor_return';
ALTER TYPE "StockStatus" ADD VALUE 'repair';

-- AlterTable: BIS Hallmark Unique ID captured at stock-in.
ALTER TABLE "StockItem" ADD COLUMN     "huid" TEXT;
