-- Quick replies: the words a salesperson sends from the inbox with one tap.
--
-- Until now there were three of them and they were written into
-- conversations/page.tsx, down to "0.50 ct solitaire ring" and "IGI
-- laser-inscribed". They could not be reworded, reordered, scoped to a branch,
-- or used at all once WhatsApp's 24-hour window had closed — which is the one
-- moment the client asked about ("if anybody missed their message so they can
-- contact after that").

-- CreateTable
CREATE TABLE "QuickReply" (
    "organisationId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "storeId" TEXT,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT,
    "templateAssetId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuickReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuickReply_organisationId_isActive_sortOrder_idx" ON "QuickReply"("organisationId", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "QuickReply_organisationId_storeId_idx" ON "QuickReply"("organisationId", "storeId");

-- AddForeignKey
ALTER TABLE "QuickReply" ADD CONSTRAINT "QuickReply_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickReply" ADD CONSTRAINT "QuickReply_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the three that were hardcoded, with their current wording, for every
-- organisation that exists.
--
-- As DATA, not as code that re-asserts itself: this runs once, so a client who
-- deletes "IGI Certificate Info" or rewrites the Saturday line keeps that
-- decision through every later deploy. The literal "0.50 ct solitaire ring" and
-- "10:30 AM to 8:30 PM" are preserved exactly as they shipped — they are the
-- client's words now, and hers to change on the management screen.
--
-- `{customer}` and `{branch}` are the same two substitutions the hardcoded
-- chips already made (the customer's name, and the branch the thread belongs
-- to); the stand-in for a missing value is applied when the chip is used, so
-- nothing raw ever reaches the composer.
--
-- Every seeded row is storeId NULL — every branch — because that is how all
-- three behaved when they were in the page.
INSERT INTO "QuickReply" ("organisationId", "id", "storeId", "label", "kind", "body", "sortOrder", "isActive", "createdAt", "updatedAt")
SELECT o."id", o."id" || ':qr-visit', NULL, 'Confirm Saturday Visit', 'free_text',
       'Hello {customer}! Would you like us to reserve a 0.50 ct solitaire ring for your visit this Saturday?',
       0, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Organisation" o;

INSERT INTO "QuickReply" ("organisationId", "id", "storeId", "label", "kind", "body", "sortOrder", "isActive", "createdAt", "updatedAt")
SELECT o."id", o."id" || ':qr-location', NULL, 'Store Location', 'free_text',
       'Our {branch} showroom is open 10:30 AM to 8:30 PM. Shall I send you the address?',
       1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Organisation" o;

INSERT INTO "QuickReply" ("organisationId", "id", "storeId", "label", "kind", "body", "sortOrder", "isActive", "createdAt", "updatedAt")
SELECT o."id", o."id" || ':qr-certificate', NULL, 'IGI Certificate Info', 'free_text',
       'All solitaires come with certified IGI laser-inscribed documentation and lifetime buyback guarantee.',
       2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Organisation" o;
