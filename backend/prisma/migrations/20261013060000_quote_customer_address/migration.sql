-- The customer's own address as typed on the quote (13 Oct). Not "billTo",
-- which is the GST bill-to block.
ALTER TABLE "Quote" ADD COLUMN "customerAddress" TEXT;
