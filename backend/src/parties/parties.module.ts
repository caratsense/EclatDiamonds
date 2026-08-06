import { Module } from '@nestjs/common';
import { PartiesController } from './parties.controller';
import { PartiesService } from './parties.service';

@Module({ controllers: [PartiesController], providers: [PartiesService] })
export class PartiesModule {}
