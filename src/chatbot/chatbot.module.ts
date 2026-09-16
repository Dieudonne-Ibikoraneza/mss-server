import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventsModule } from '@/events/events.module';
import { StorageModule } from '@/storage/storage.module';
import { TranslationModule } from '@/translation/translation.module';
import { ChatbotController } from './chatbot.controller';
import { ChatbotService } from './chatbot.service';
import { CHAT_PROVIDER } from './providers/chat-provider.interface';
import { StubChatProvider } from './providers/stub-chat.provider';
import { GeminiChatProvider } from './providers/gemini-chat.provider';
import { GeminiImageProvider } from './providers/gemini-image.provider';
import { RECOMMENDATION_IMAGE_PROVIDER } from './providers/recommendation-image.provider';
import { StubRecommendationImageProvider } from './providers/recommendation-image.stub';
import { ROOM_TILE_EDIT_PROVIDER } from './providers/room-tile-provider.interface';
import { GeminiRoomTileProvider } from './providers/gemini-room-tile.provider';
import { StubRoomTileProvider } from './providers/room-tile.stub';

@Module({
  imports: [EventsModule, ConfigModule, StorageModule, TranslationModule],
  controllers: [ChatbotController],
  providers: [
    ChatbotService,
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
    {
      provide: ROOM_TILE_EDIT_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        (config.get<string>('ai.image.provider') ?? 'stub') === 'gemini'
          ? new GeminiRoomTileProvider(config)
          : new StubRoomTileProvider(),
    },
  ],
})
export class ChatbotModule {}
