import { Module } from '@nestjs/common';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';
import { DeadStockService } from './dead-stock.service';
import { DeadStockController, StockVinController } from './dead-stock.controller';

/**
 * Inventory, and the two questions about a piece that had no answer: which
 * design is it, and which piece is it.
 *
 * `DeadStockService` is exported because the threshold it resolves decides what
 * the stock summary's dead-stock figure means — one definition, read by both,
 * rather than a constant in each that drift apart.
 */
@Module({
  controllers: [StockController, DeadStockController, StockVinController],
  providers: [StockService, DeadStockService],
  exports: [DeadStockService],
})
export class StockModule {}
