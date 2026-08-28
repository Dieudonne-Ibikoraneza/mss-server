import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventsModule } from '@/events/events.module';
import { ChatbotController } from './chatbot.controller';
import { ChatbotService } from './chatbot.service';
import { CHAT_PROVIDER } from './providers/chat-provider.interface';
import { StubChatProvider } from './providers/stub-chat.provider';
import { GeminiChatProvider } from './providers/gemini-chat.provider';
import {
  StubImagePreviewProvider,
  StubVideoPreviewProvider,
} from './providers/stub-media.provider';

@Module({
  imports: [EventsModule, ConfigModule],
  controllers: [ChatbotController],
  providers: [
    ChatbotService,
    StubImagePreviewProvider,
    StubVideoPreviewProvider,
    {
      provide: CHAT_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const provider = config.get<string>('ai.chat.provider') ?? 'stub';
        const apiKey = config.get<string>('ai.chat.apiKey');
        if (provider === 'gemini' && apiKey) {
          return new GeminiChatProvider(config);
        }
        return new StubChatProvider();
      },
    },
  ],
})
export class ChatbotModule {}
