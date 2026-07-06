import { Module } from '@nestjs/common';
import { MarketingController } from './marketing.controller';
import { MarketingService } from './marketing.service';

@Module({ controllers: [MarketingController], providers: [MarketingService] })
export class MarketingModule {}
