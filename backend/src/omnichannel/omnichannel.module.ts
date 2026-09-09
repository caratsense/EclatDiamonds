import { Global, Module } from '@nestjs/common';

import { OmnichannelController } from './omnichannel.controller';
import { OmnichannelService } from './omnichannel.service';
import { TemplateSyncService } from './template-sync.service';

/** Universal messaging policy + durable delivery layer. */
@Global()
@Module({
  controllers: [OmnichannelController],
  providers: [OmnichannelService, TemplateSyncService],
  exports: [OmnichannelService, TemplateSyncService],
})
export class OmnichannelModule {}

