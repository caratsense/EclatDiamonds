import { Module } from '@nestjs/common';
import { StoresController } from './stores.controller';
import { RegionsController } from './regions.controller';
import { StoresService } from './stores.service';

@Module({
  controllers: [StoresController, RegionsController],
  providers: [StoresService],
})
export class StoresModule {}
