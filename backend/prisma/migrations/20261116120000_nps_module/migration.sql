-- AlterTable
ALTER TABLE "FeedbackRequest" ADD COLUMN     "reminderDueAt" TIMESTAMP(3),
ADD COLUMN     "reminderMessageId" TEXT,
ADD COLUMN     "reminderSentAt" TIMESTAMP(3),
ADD COLUMN     "repliedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "NpsResponse" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "rawName" TEXT,
    "rawNumber" TEXT,
    "phoneE164" TEXT,
    "firstPurchase" TEXT,
    "recommendAnswer" TEXT,
    "visitPurpose" TEXT,
    "likedMost" TEXT,
    "couldImprove" TEXT,
    "notFound" TEXT,
    "heardAboutUs" TEXT,
    "followsSocial" TEXT,
    "concerns" TEXT,
    "score" INTEGER,
    "matchState" TEXT NOT NULL DEFAULT 'unmatched',
    "matchNote" TEXT,
    "partyId" TEXT,
    "checkInId" TEXT,
    "requestId" TEXT,
    "importKey" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NpsResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NpsFollowup" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "followupDate" TIMESTAMP(3),
    "rawName" TEXT,
    "rawNumber" TEXT,
    "phoneE164" TEXT,
    "response" TEXT,
    "partyId" TEXT,
    "checkInId" TEXT,
    "matchState" TEXT NOT NULL DEFAULT 'unmatched',
    "matchNote" TEXT,
    "importKey" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NpsFollowup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NpsResponse_importKey_key" ON "NpsResponse"("importKey");

-- CreateIndex
CREATE INDEX "NpsResponse_organisationId_submittedAt_idx" ON "NpsResponse"("organisationId", "submittedAt");

-- CreateIndex
CREATE INDEX "NpsResponse_organisationId_matchState_idx" ON "NpsResponse"("organisationId", "matchState");

-- CreateIndex
CREATE INDEX "NpsResponse_organisationId_phoneE164_idx" ON "NpsResponse"("organisationId", "phoneE164");

-- CreateIndex
CREATE UNIQUE INDEX "NpsFollowup_importKey_key" ON "NpsFollowup"("importKey");

-- CreateIndex
CREATE INDEX "NpsFollowup_organisationId_submittedAt_idx" ON "NpsFollowup"("organisationId", "submittedAt");

-- CreateIndex
CREATE INDEX "NpsFollowup_organisationId_phoneE164_idx" ON "NpsFollowup"("organisationId", "phoneE164");

-- CreateIndex
CREATE INDEX "FeedbackRequest_organisationId_checkInId_idx" ON "FeedbackRequest"("organisationId", "checkInId");

-- AddForeignKey
ALTER TABLE "NpsResponse" ADD CONSTRAINT "NpsResponse_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NpsResponse" ADD CONSTRAINT "NpsResponse_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NpsResponse" ADD CONSTRAINT "NpsResponse_checkInId_fkey" FOREIGN KEY ("checkInId") REFERENCES "CheckIn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NpsResponse" ADD CONSTRAINT "NpsResponse_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "FeedbackRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NpsFollowup" ADD CONSTRAINT "NpsFollowup_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NpsFollowup" ADD CONSTRAINT "NpsFollowup_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NpsFollowup" ADD CONSTRAINT "NpsFollowup_checkInId_fkey" FOREIGN KEY ("checkInId") REFERENCES "CheckIn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

