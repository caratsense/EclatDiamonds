import { Global, Module, forwardRef } from '@nestjs/common';

import { CrmModule } from '../crm/crm.module';
import { IntegrationModule } from '../integration/integration.module';
import { OmnichannelController } from './omnichannel.controller';
import { OmnichannelService } from './omnichannel.service';
import { MetaUploadService } from './meta-upload.service';
import { TemplateSyncService } from './template-sync.service';

/** Universal messaging policy + durable delivery layer. */
@Global()
@Module({
  /*
   * IntegrationModule for IntegrationsRegistryService, which TemplateSyncService
   * asks for the WhatsApp access token when uploading a template image. It
   * exports the service but is not @Global, so it has to be imported here —
   * missing it crashed the container on boot with an
   * UnknownDependenciesException, which unit tests cannot catch because they
   * never build the Nest graph.
   *
   * forwardRef for the same reason CrmModule has one: this module is @Global
   * and sits in the middle of several import cycles.
   */
  imports: [forwardRef(() => CrmModule), forwardRef(() => IntegrationModule)],
  controllers: [OmnichannelController],
  providers: [OmnichannelService, TemplateSyncService, MetaUploadService],
  exports: [OmnichannelService, TemplateSyncService],
})
export class OmnichannelModule {}

