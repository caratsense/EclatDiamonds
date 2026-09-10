import { Module, OnModuleInit } from '@nestjs/common';

import { JobsService } from '../jobs/jobs.service';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeStorageService } from './knowledge-storage.service';
import { KNOWLEDGE_EXTRACT_JOB, KnowledgeService } from './knowledge.service';

@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService, KnowledgeStorageService],
  exports: [KnowledgeService],
})
export class KnowledgeModule implements OnModuleInit {
  constructor(private readonly jobs: JobsService, private readonly knowledge: KnowledgeService) {}

  onModuleInit(): void {
    this.jobs.register(KNOWLEDGE_EXTRACT_JOB, async (payload, context) => {
      const documentId = (payload as { documentId?: string }).documentId;
      if (!documentId || !context.organisationId) throw new Error('Invalid knowledge extraction job.');
      return this.knowledge.extract(context.organisationId, documentId);
    });
  }
}
