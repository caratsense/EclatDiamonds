import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { WhatsAppBotModule } from '../whatsapp-bot/whatsapp-bot.module';

@Module({
  imports: [WhatsAppBotModule],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
