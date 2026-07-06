-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "storeId" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "assignee" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "dueDate" DATE,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Task_storeId_status_idx" ON "Task"("storeId", "status");
