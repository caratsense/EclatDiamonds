-- AlterTable
ALTER TABLE "AttendanceRecord" ADD COLUMN     "checkInDistanceM" INTEGER,
ADD COLUMN     "checkOutLat" DECIMAL(10,7),
ADD COLUMN     "checkOutLng" DECIMAL(10,7),
ADD COLUMN     "workedMins" INTEGER;

-- AlterTable
ALTER TABLE "LeaveRequest" ADD COLUMN     "days" DECIMAL(4,1),
ADD COLUMN     "halfDay" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "leaveTypeId" TEXT;

-- CreateTable
CREATE TABLE "LeaveBalance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "storeId" TEXT,
    "type" "LeaveType" NOT NULL,
    "year" INTEGER NOT NULL,
    "allocated" DECIMAL(5,1) NOT NULL DEFAULT 0,
    "used" DECIMAL(5,1) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaveBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceRegularization" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "staffName" TEXT,
    "date" DATE NOT NULL,
    "requestedCheckIn" TIMESTAMP(3),
    "requestedCheckOut" TIMESTAMP(3),
    "reason" TEXT,
    "status" "LeaveStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceRegularization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeaveBalance_userId_year_idx" ON "LeaveBalance"("userId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveBalance_userId_type_year_key" ON "LeaveBalance"("userId", "type", "year");

-- CreateIndex
CREATE INDEX "AttendanceRegularization_storeId_date_idx" ON "AttendanceRegularization"("storeId", "date");

-- AddForeignKey
ALTER TABLE "LeaveBalance" ADD CONSTRAINT "LeaveBalance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRegularization" ADD CONSTRAINT "AttendanceRegularization_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
