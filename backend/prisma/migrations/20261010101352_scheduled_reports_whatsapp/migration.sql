-- AlterTable
ALTER TABLE "ScheduledReport" ADD COLUMN     "phoneRecipients" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ScheduledReportRun" ADD COLUMN     "whatsappDetail" TEXT,
ADD COLUMN     "whatsappStatus" TEXT NOT NULL DEFAULT 'no_recipients';
