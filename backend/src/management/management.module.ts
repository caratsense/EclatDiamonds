import { Module } from '@nestjs/common';

import { ManagementController } from './management.controller';
import { ManagementService } from './management.service';

/**
 * The management view (Block 15).
 *
 * No imports: PrismaService, StoreScopeService and AuditService are all global.
 * Nothing else is needed, and that is the point — this module only READS. It
 * writes exactly one row, an audit line when somebody exports the detail.
 */
@Module({
  controllers: [ManagementController],
  providers: [ManagementService],
})
export class ManagementModule {}
