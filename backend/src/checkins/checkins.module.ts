import { Module } from '@nestjs/common';
import { CheckinsController } from './checkins.controller';
import { CheckinsService } from './checkins.service';
import { ProvenanceTagsService } from '../crm/provenance-tags.service';

@Module({ controllers: [CheckinsController], providers: [ProvenanceTagsService, CheckinsService], exports: [CheckinsService] })
export class CheckinsModule {}
