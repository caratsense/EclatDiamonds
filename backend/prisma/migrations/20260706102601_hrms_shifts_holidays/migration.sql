-- AlterTable
ALTER TABLE "AttendanceRecord" ADD COLUMN     "isLate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lateMinutes" INTEGER,
ADD COLUMN     "shiftId" TEXT;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "weekOffDay" INTEGER;

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "bufferMins" INTEGER NOT NULL DEFAULT 15,
    "isNightBatch" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreHoliday" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreHoliday_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Shift_storeId_idx" ON "Shift"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreHoliday_storeId_date_key" ON "StoreHoliday"("storeId", "date");

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreHoliday" ADD CONSTRAINT "StoreHoliday_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
