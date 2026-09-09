import { Module } from '@nestjs/common';

import { TenantConfigController } from './tenant-config.controller';
import { TenantConfigService } from './tenant-config.service';

/**
 * The per-tenant configuration layer (CaratOS Phase A2). Exported so other
 * modules can read a tenant's vocabulary without importing the controller.
 */
@Module({
  controllers: [TenantConfigController],
  providers: [TenantConfigService],
  exports: [TenantConfigService],
})
export class TenantConfigModule {}
