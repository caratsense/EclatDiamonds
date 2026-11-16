import { Module } from '@nestjs/common';
import { PartiesController } from './parties.controller';
import { PartiesService } from './parties.service';
import { PartyArchiveService } from './party-archive.service';
import { SpecialRequestsModule } from '../special-requests/special-requests.module';

@Module({
  // A deletion ASK is a special request like any other, so it is raised through
  // that service and lands in the approvals queue the branch already works,
  // rather than in a second inbox that only ever holds deletions.
  imports: [SpecialRequestsModule],
  controllers: [PartiesController],
  providers: [PartiesService, PartyArchiveService],
  exports: [PartyArchiveService],
})
export class PartiesModule {}
