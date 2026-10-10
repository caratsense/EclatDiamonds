-- Reorder requests (client 9 Oct 2026, item 16): a branch asks for more pieces
-- of a design that sells, through the existing special-request ladder. The kind
-- gains a product reference + quantity; everything else (approver derivation,
-- decision record, thread) is the SpecialRequest machinery unchanged.

ALTER TYPE "SpecialRequestKind" ADD VALUE 'reorder' AFTER 'stock_transfer';

ALTER TABLE "SpecialRequest" ADD COLUMN "productId" TEXT,
ADD COLUMN "quantity" INTEGER;

ALTER TABLE "SpecialRequest" ADD CONSTRAINT "SpecialRequest_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "SpecialRequest_productId_idx" ON "SpecialRequest"("productId");
