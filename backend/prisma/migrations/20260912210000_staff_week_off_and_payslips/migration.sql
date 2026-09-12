-- Individual weekly offs, and a payslip built from the attendance register.
--
-- WEEKLY OFF was a property of the STORE: one day, everybody, every week. A shop
-- that never closes cannot work that way — the staff rotate, and marking the
-- whole branch off on a Tuesday when half of it is on the floor makes the
-- register fiction. Now an employee may have their own day (or two). No rows
-- means they follow the store's weekOffDay, so every existing tenant behaves
-- exactly as it does today.
--
-- PAYSLIPS are generated from the register and then FROZEN. A payslip that
-- recomputed from live data would let a roster edited in October silently change
-- September's slip, and the number the employee was shown would no longer exist
-- anywhere. Everything that went into the figure is stored here, including the
-- day-by-day breakdown.
--
-- This is not statutory payroll: no tax, no PF, no ESI, no bank file. It answers
-- "how many days was this person paid for, and what does that come to" — the
-- question the attendance register can actually answer. Anything needing a tax
-- table is left to the accountant rather than approximated.
--
-- All additive. Nothing here runs until somebody records a salary.

CREATE TABLE "StaffWeekOff" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- An employee mapped to two branches can have a different off day at each.
    "storeId" TEXT,
    -- 0 = Sunday … 6 = Saturday, read in the STORE's timezone.
    "dayOfWeek" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffWeekOff_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StaffWeekOff_userId_storeId_dayOfWeek_key"
    ON "StaffWeekOff"("userId", "storeId", "dayOfWeek");
CREATE INDEX "StaffWeekOff_organisationId_storeId_idx"
    ON "StaffWeekOff"("organisationId", "storeId");

CREATE TABLE "StaffCompensation" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- 'monthly' | 'daily'. Not cosmetic: on a monthly basis the weekly offs and
    -- holidays are PAID, on a daily basis they are not. Paying one as the other
    -- is a real overpayment or underpayment every single month.
    "basis" TEXT NOT NULL DEFAULT 'monthly',
    "amount" DECIMAL(12,2) NOT NULL,
    "paidLeavePerMonth" DECIMAL(4,1),
    -- Per HOUR. NULL means overtime is not paid — the honest default, because
    -- paying it by accident is worse than the conversation about whether to.
    "overtimeHourlyRate" DECIMAL(10,2),
    "effectiveFrom" DATE,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffCompensation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StaffCompensation_userId_key" ON "StaffCompensation"("userId");

CREATE TABLE "Payslip" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "storeId" TEXT,
    "periodKey" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    -- 'draft' recomputes on request; 'issued' never changes, because it is what
    -- the employee was shown.
    "status" TEXT NOT NULL DEFAULT 'draft',
    "issuedAt" TIMESTAMP(3),
    "issuedById" TEXT,

    "calendarDays" INTEGER NOT NULL,
    "weeklyOffDays" INTEGER NOT NULL,
    "holidayDays" INTEGER NOT NULL,
    -- Sum of dayFraction: a half day counts 0.5, which is what payroll consumes.
    "presentDays" DECIMAL(5,2) NOT NULL,
    "paidLeaveDays" DECIMAL(5,2) NOT NULL,
    -- The number that actually costs the employee.
    "unpaidDays" DECIMAL(5,2) NOT NULL,
    "overtimeMins" INTEGER NOT NULL DEFAULT 0,

    "basis" TEXT NOT NULL,
    -- The compensation figures AS THEY WERE at generation.
    "amount" DECIMAL(12,2) NOT NULL,
    "perDayRate" DECIMAL(12,2) NOT NULL,
    "earnedAmount" DECIMAL(12,2) NOT NULL,
    "overtimeAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "deductionAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "netPay" DECIMAL(12,2) NOT NULL,

    -- Day by day, so a disputed slip can be walked line by line rather than
    -- argued about from a single total.
    "breakdown" JSONB,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payslip_pkey" PRIMARY KEY ("id")
);

-- One slip per person per month. Regenerating replaces the draft in place;
-- producing a second September slip for one employee is not a state anybody
-- could act on.
CREATE UNIQUE INDEX "Payslip_userId_periodKey_key" ON "Payslip"("userId", "periodKey");
CREATE INDEX "Payslip_organisationId_periodKey_idx" ON "Payslip"("organisationId", "periodKey");
CREATE INDEX "Payslip_organisationId_storeId_periodKey_idx"
    ON "Payslip"("organisationId", "storeId", "periodKey");

ALTER TABLE "StaffWeekOff"
    ADD CONSTRAINT "StaffWeekOff_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- CASCADE on the user throughout: a roster entry, a salary and a payslip are all
-- statements ABOUT a person. None of them means anything once the person's
-- record is gone, and an orphan payslip is a number nobody can attribute.
ALTER TABLE "StaffWeekOff"
    ADD CONSTRAINT "StaffWeekOff_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StaffCompensation"
    ADD CONSTRAINT "StaffCompensation_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StaffCompensation"
    ADD CONSTRAINT "StaffCompensation_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Payslip"
    ADD CONSTRAINT "Payslip_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Payslip"
    ADD CONSTRAINT "Payslip_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
