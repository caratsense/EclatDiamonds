import { Module } from '@nestjs/common';
import { HrmsController } from './hrms.controller';
import { HrmsService } from './hrms.service';
import { AttendancePhotoService } from './attendance-photo.service';

@Module({
  controllers: [HrmsController],
  providers: [HrmsService, AttendancePhotoService],
  // Exported so the scheduler can run the nightly attendance day-close.
  exports: [HrmsService],
})
export class HrmsModule {}
