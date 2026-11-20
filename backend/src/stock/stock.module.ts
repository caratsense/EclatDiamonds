import { Module } from '@nestjs/common';
import { StockController } from './stock.controller';
import { StockByStoreService } from './stock-by-store.service';
import { StockService } from './stock.service';
import { DeadStockService } from './dead-stock.service';
import { DeadStockController, StockVinController } from './dead-stock.controller';
import { LowStockController } from './low-stock.controller';
import { LowStockService } from './low-stock.service';

/**
 * Inventory, and the two questions about a piece that had no answer: which
 * design is it, and which piece is it.
 *
 * `DeadStockService` is exported because the threshold it resolves decides what
 * the stock summary's dead-stock figure means — one definition, read by both,
 * rather than a constant in each that drift apart.
 *
 * `LowStockService` carries its own @Cron (as the catalogue index sweep does)
 * rather than being driven from SchedulerService: it needs nothing from the
 * scheduler's per-store run machinery, because its alert rows are the claim.
 */
@Module({
  controllers: [StockController, DeadStockController, StockVinController, LowStockController],
  providers: [StockService, DeadStockService, StockByStoreService, LowStockService],
  exports: [DeadStockService],
})
export class StockModule {}
