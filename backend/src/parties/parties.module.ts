import { Module } from '@nestjs/common';
import { PartiesController } from './parties.controller';
import { PartiesService } from './parties.service';
import { PartyArchiveService } from './party-archive.service';

@Module({
  controllers: [PartiesController],
  providers: [PartiesService, PartyArchiveService],
  exports: [PartyArchiveService],
})
export class PartiesModule {}
