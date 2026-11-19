import { Module } from '@nestjs/common';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { ProvenanceTagsService } from '../crm/provenance-tags.service';

@Module({ controllers: [LeadsController], providers: [ProvenanceTagsService, LeadsService] })
export class LeadsModule {}
