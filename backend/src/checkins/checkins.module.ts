import { Module } from '@nestjs/common';
import { CheckinsController } from './checkins.controller';
import { CheckinsService } from './checkins.service';

@Module({ controllers: [CheckinsController], providers: [CheckinsService] })
export class CheckinsModule {}
