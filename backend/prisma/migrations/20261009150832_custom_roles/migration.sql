-- AlterTable
ALTER TABLE "User" ADD COLUMN     "customRoleName" TEXT;

-- CreateTable
CREATE TABLE "CustomRole" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseRole" "Role" NOT NULL,
    "overrides" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomRole_organisationId_name_key" ON "CustomRole"("organisationId", "name");

-- AddForeignKey
ALTER TABLE "CustomRole" ADD CONSTRAINT "CustomRole_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
