import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

/**
 * Sales (Direct Sales) format + Module 12 payment capture folded in.
 * Additive to the legacy-synced sales and the existing payments module.
 */
@Module({ controllers: [SalesController], providers: [SalesService] })
export class SalesModule {}
