-- Website lead-capture forms.
--
-- Purely additive: one new table, no column added to or removed from anything
-- that already holds data, so every existing row stays valid and a rollback is
-- `DROP TABLE "LeadForm"` with nothing else to undo.
--
-- `publicKey` is globally unique on purpose. The public submit endpoint resolves
-- the tenant FROM this value with no organisation in hand, so a key that could
-- repeat across tenants would let one tenant's form file leads into another's
-- CRM. The unique index is the enforcement, not the generator.

CREATE TABLE "LeadForm" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "defaultInterest" TEXT,
    "campaign" TEXT,
    "allowedOrigins" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadForm_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LeadForm_publicKey_key" ON "LeadForm"("publicKey");
CREATE INDEX "LeadForm_organisationId_idx" ON "LeadForm"("organisationId");
CREATE INDEX "LeadForm_storeId_idx" ON "LeadForm"("storeId");

ALTER TABLE "LeadForm" ADD CONSTRAINT "LeadForm_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeadForm" ADD CONSTRAINT "LeadForm_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
