-- Old gold taken in part-exchange against a sale line.
--
-- The legacy bill carries it as a component of the line total (checked against
-- the 8 Jun 2026 APRSSJEP backup: MRP = metal + diamond + CPF + imitation +
-- exchange on 3,275 of 3,275 lines), so without a column of its own an imported
-- line does not add up. Additive and nullable: existing rows are unaffected and
-- read as "not recorded", which is what they are.
ALTER TABLE "SaleLine" ADD COLUMN IF NOT EXISTS "exchangeAmount" DECIMAL(14,2);
