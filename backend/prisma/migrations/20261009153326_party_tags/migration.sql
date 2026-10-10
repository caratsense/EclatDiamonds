-- CreateTable
CREATE TABLE "PartyTagAssignment" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartyTagAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PartyTagAssignment_organisationId_tagId_idx" ON "PartyTagAssignment"("organisationId", "tagId");

-- CreateIndex
CREATE UNIQUE INDEX "PartyTagAssignment_partyId_tagId_key" ON "PartyTagAssignment"("partyId", "tagId");

-- AddForeignKey
ALTER TABLE "PartyTagAssignment" ADD CONSTRAINT "PartyTagAssignment_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartyTagAssignment" ADD CONSTRAINT "PartyTagAssignment_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartyTagAssignment" ADD CONSTRAINT "PartyTagAssignment_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "LeadTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
