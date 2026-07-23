-- Make gold-savings scheme plans client-configurable, and remove the demo plans.
--
-- The client has NOT activated Module 17's gold-savings scheme (marked LATER in
-- the discovery call), so the four seeded plans were demo scaffolding, not the
-- client's product. They are removed here; Head Office now creates the real
-- plan(s) in-app (optionally from a template) whenever the scheme goes live.

-- 1) A plan can now carry a suggested monthly installment (e.g. 5000 for the
--    client's "₹5,000 × 11 months, 12th free" scheme). Null = entered per member.
ALTER TABLE "SchemePlan" ADD COLUMN "defaultInstallment" DECIMAL(14,2);

-- 2) Drop the demo plans and their demo enrollments, child rows first so the
--    foreign keys hold. Scoped strictly to the four SEEDED ids (`plan-*`), which
--    are seed-authored literals — real plans created in-app get a cuid, so a
--    client-created plan can never match this filter.
DELETE FROM "SchemeInstallment"
 WHERE "memberId" IN (
   SELECT "id" FROM "SchemeMember"
    WHERE "planId" IN ('plan-11', 'plan-11p1', 'plan-11p2', 'plan-24p3')
 );

DELETE FROM "SchemeMember"
 WHERE "planId" IN ('plan-11', 'plan-11p1', 'plan-11p2', 'plan-24p3');

DELETE FROM "SchemePlan"
 WHERE "id" IN ('plan-11', 'plan-11p1', 'plan-11p2', 'plan-24p3');
