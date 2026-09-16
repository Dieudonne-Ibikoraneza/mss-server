import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TranslationService } from './translation.service';
import { TRANSLATION_PROVIDER } from './providers/translation-provider.interface';
import { StubTranslationProvider } from './providers/stub-translation.provider';
import { GoogleTranslationProvider } from './providers/google-translation.provider';

/**
 * Auto-translates dynamic, DB-stored content (product/collection/room copy,
 * knowledge-base entries) into Kinyarwanda — the static UI strings are
 * react-i18next's job on the client; this is for the free-text a customer
 * or staff member actually types in, which no locale JSON file can cover.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    TranslationService,
    {
      provide: TRANSLATION_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const provider = config.get<string>('translate.provider') ?? 'stub';
        const apiKey = config.get<string>('translate.googleApiKey');
        if (provider === 'google' && apiKey) {
          return new GoogleTranslationProvider(config);
        }
        return new StubTranslationProvider();
      },
    },
  ],
  exports: [TranslationService],
})
export class TranslationModule {}
