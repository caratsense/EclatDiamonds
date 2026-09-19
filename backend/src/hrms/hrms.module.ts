import { Module } from '@nestjs/common';
import { HrmsController } from './hrms.controller';
import { HrmsService } from './hrms.service';
import { AttendancePhotoService } from './attendance-photo.service';
import { PayrollService } from './payroll.service';
import { PayrollController } from './payroll.controller';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { AttendanceOpsService } from './attendance-ops.service';
import { AttendanceAnalyticsController } from './attendance-analytics.controller';
import { AttendanceAnalyticsService } from './attendance-analytics.service';

/**
 * Attendance, the roster, and what a month of it comes to.
 *
 * `PayrollService` owns the weekly-off resolution (the employee's own days, else
 * the branch's) and `HrmsService.dayClose` reads it, so there is one answer to
 * "is this person off today" rather than one in the day-close and another in
 * payroll quietly disagreeing.
 */
@Module({
  controllers: [HrmsController, PayrollController, EmployeesController, AttendanceAnalyticsController],
  providers: [
    HrmsService,
    AttendancePhotoService,
    PayrollService,
    EmployeesService,
    AttendanceOpsService,
    AttendanceAnalyticsService,
  ],
  // Exported so the scheduler can run the nightly attendance day-close.
  exports: [HrmsService, PayrollService, AttendanceOpsService],
})
export class HrmsModule {}
