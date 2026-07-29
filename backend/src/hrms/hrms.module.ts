import { Module } from '@nestjs/common';
import { HrmsController } from './hrms.controller';
import { HrmsService } from './hrms.service';

@Module({
  controllers: [HrmsController],
  providers: [HrmsService],
  // Exported so the scheduler can run the nightly attendance day-close.
  exports: [HrmsService],
})
export class HrmsModule {}
