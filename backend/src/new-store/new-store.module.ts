import { Module } from '@nestjs/common';
import { NewStoreController } from './new-store.controller';
import { NewStoreService } from './new-store.service';

@Module({ controllers: [NewStoreController], providers: [NewStoreService] })
export class NewStoreModule {}
