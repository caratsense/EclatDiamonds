-- Tenant-defined labels on a lead.
--
-- The meeting asked to "tag a contact as a potential lead", and separately asked
-- that larger stores be able to configure their own fields. A hard-coded
-- `isPotentialLead` boolean answers the first and not the second, and has to be
-- migrated again the moment anyone wants a second label. One tenant-owned tag
-- list answers both.
--
-- These are NOT ad-set routing tags. Routing tags are written by the attribution
-- engine to decide which branch an inbound click belongs to; these are written by
-- a salesperson about a person they spoke to. Keeping them in separate tables is
-- what stops a marketing rule change from silently re-labelling someone's leads.
--
-- Additive only. Nothing existing is altered, so this is safe to apply ahead of
-- the code that reads it, and rolling back is DROP TABLE on two empty tables.

CREATE TABLE "LeadTag" (
    "organisationId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    -- Case- and whitespace-normalised name. "Potential Lead", "potential lead"
    -- and "Potential  Lead" must not become three tags in one tenant.
    "slug" TEXT NOT NULL,
    "colour" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadTag_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LeadTagAssignment" (
    "organisationId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "assignedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadTagAssignment_pkey" PRIMARY KEY ("id")
);

-- Tenant-scoped, so two organisations may both define "Potential Lead" and
-- neither can see or collide with the other's.
CREATE UNIQUE INDEX "LeadTag_organisationId_slug_key" ON "LeadTag"("organisationId", "slug");
CREATE INDEX "LeadTag_organisationId_isActive_sortOrder_idx" ON "LeadTag"("organisationId", "isActive", "sortOrder");

-- Applying the same tag twice is the same tag, not two.
CREATE UNIQUE INDEX "LeadTagAssignment_leadId_tagId_key" ON "LeadTagAssignment"("leadId", "tagId");
CREATE INDEX "LeadTagAssignment_organisationId_idx" ON "LeadTagAssignment"("organisationId");
CREATE INDEX "LeadTagAssignment_tagId_idx" ON "LeadTagAssignment"("tagId");

ALTER TABLE "LeadTag"
    ADD CONSTRAINT "LeadTag_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeadTagAssignment"
    ADD CONSTRAINT "LeadTagAssignment_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- CASCADE on both: an assignment is meaningless without either end. Deleting a
-- lead removes its labels; retiring a tag removes it from the leads that carried
-- it. Neither deletes the lead or the tag itself, which is why `isActive` exists
-- — retiring a tag is the normal path, deleting one is not.
ALTER TABLE "LeadTagAssignment"
    ADD CONSTRAINT "LeadTagAssignment_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "Lead"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LeadTagAssignment"
    ADD CONSTRAINT "LeadTagAssignment_tagId_fkey"
    FOREIGN KEY ("tagId") REFERENCES "LeadTag"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
