-- WhatsApp reporting bot — Phase 1 (identity).
-- A verified phone->user binding, kept separate from User.phone so OTP login is
-- untouched. Plus a short-lived, single-use code the user sends to the bot to
-- prove control of the number they are linking.

CREATE TABLE "WhatsAppIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "verifiedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppIdentity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WhatsAppIdentity_phoneE164_key" ON "WhatsAppIdentity"("phoneE164");
CREATE INDEX "WhatsAppIdentity_userId_idx" ON "WhatsAppIdentity"("userId");

CREATE TABLE "WhatsAppLinkCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppLinkCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WhatsAppLinkCode_userId_createdAt_idx" ON "WhatsAppLinkCode"("userId", "createdAt");

ALTER TABLE "WhatsAppIdentity" ADD CONSTRAINT "WhatsAppIdentity_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WhatsAppLinkCode" ADD CONSTRAINT "WhatsAppLinkCode_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
