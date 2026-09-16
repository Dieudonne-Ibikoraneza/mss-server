import { Injectable, Logger } from '@nestjs/common';
import type { Language } from '@prisma/client';
import type { TranslationProvider } from './translation-provider.interface';

/**
 * Used whenever TRANSLATE_PROVIDER isn't set to a real provider. Returns
 * `null` for every string rather than echoing it back — an obviously-wrong
 * fake translation is worse than the target column staying null (which
 * every consumer already treats as "not translated yet, fall back to the
 * other language"), and local dev shouldn't need real Google Cloud
 * credentials.
 */
@Injectable()
export class StubTranslationProvider implements TranslationProvider {
  private readonly logger = new Logger(StubTranslationProvider.name);

  translate(texts: string[], source: Language, target: Language): Promise<(string | null)[]> {
    this.logger.debug(
      `Stub translate (no-op) for ${texts.length} string(s): ${source} -> ${target}`,
    );
    return Promise.resolve(texts.map(() => null));
  }
}
