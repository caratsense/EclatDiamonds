import { Module } from '@nestjs/common';
import { SpecialRequestsController } from './special-requests.controller';
import { SpecialRequestsService } from './special-requests.service';

@Module({
  controllers: [SpecialRequestsController],
  providers: [SpecialRequestsService],
  exports: [SpecialRequestsService],
})
export class SpecialRequestsModule {}
