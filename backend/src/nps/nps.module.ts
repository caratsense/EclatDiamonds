import { Module } from '@nestjs/common';

import { NpsController } from './nps.controller';
import { NpsService } from './nps.service';

@Module({
  controllers: [NpsController],
  providers: [NpsService],
  exports: [NpsService],
})
export class NpsModule {}
