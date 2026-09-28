-- Address and payments on a quote, editable after it is saved without
-- touching the price. Both nullable: every existing quote keeps printing the
-- customer's own address and "Received 0.00", exactly as before.
ALTER TABLE "Quote" ADD COLUMN "billTo" JSONB;
ALTER TABLE "Quote" ADD COLUMN "payments" JSONB;
