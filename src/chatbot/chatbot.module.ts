import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventsModule } from '@/events/events.module';
import { StorageModule } from '@/storage/storage.module';
import { ChatbotController } from './chatbot.controller';
import { ChatbotService } from './chatbot.service';
import { CHAT_PROVIDER } from './providers/chat-provider.interface';
import { StubChatProvider } from './providers/stub-chat.provider';
import { GeminiChatProvider } from './providers/gemini-chat.provider';
import { GeminiImageProvider } from './providers/gemini-image.provider';
import { RECOMMENDATION_IMAGE_PROVIDER } from './providers/recommendation-image.provider';
import { StubRecommendationImageProvider } from './providers/recommendation-image.stub';
import {
  StubImagePreviewProvider,
  StubVideoPreviewProvider,
} from './providers/stub-media.provider';

@Module({
  imports: [EventsModule, ConfigModule, StorageModule],
  controllers: [ChatbotController],
  providers: [
    ChatbotService,
    StubImagePreviewProvider,
    StubVideoPreviewProvider,
    StubRecommendationImageProvider,
    GeminiImageProvider,
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
    {
      provide: RECOMMENDATION_IMAGE_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        (config.get<string>('ai.image.provider') ?? 'stub') === 'gemini'
          ? new GeminiImageProvider(config)
          : new StubRecommendationImageProvider(),
    },
  ],
})
export class ChatbotModule {}
