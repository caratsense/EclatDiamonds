-- CreateTable
CREATE TABLE "DailyReport" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "reportDate" DATE NOT NULL,
    "reportTime" TEXT,
    "walkIns" INTEGER NOT NULL DEFAULT 0,
    "seriousEnquiries" INTEGER NOT NULL DEFAULT 0,
    "deliveredBilled" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "bookingsNew" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "advanceReceived" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cash" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "card" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "upi" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "oldGoldWtG" DECIMAL(12,3),
    "oldGoldValue" DECIMAL(14,2),
    "submittedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyReport_storeId_reportDate_idx" ON "DailyReport"("storeId", "reportDate");

-- AddForeignKey
ALTER TABLE "DailyReport" ADD CONSTRAINT "DailyReport_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
