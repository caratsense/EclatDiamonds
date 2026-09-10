import { Global, Module, forwardRef } from '@nestjs/common';

import { CrmModule } from '../crm/crm.module';
import { OmnichannelController } from './omnichannel.controller';
import { OmnichannelService } from './omnichannel.service';
import { TemplateSyncService } from './template-sync.service';

/** Universal messaging policy + durable delivery layer. */
@Global()
@Module({
  imports: [forwardRef(() => CrmModule)],
  controllers: [OmnichannelController],
  providers: [OmnichannelService, TemplateSyncService],
  exports: [OmnichannelService, TemplateSyncService],
})
export class OmnichannelModule {}

