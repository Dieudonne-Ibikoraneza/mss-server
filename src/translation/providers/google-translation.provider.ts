import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Language } from '@prisma/client';
import type { TranslationProvider } from './translation-provider.interface';

const GOOGLE_TRANSLATE_API_URL = 'https://translation.googleapis.com/language/translate2';
const REQUEST_TIMEOUT_MS = 15_000;

/** Prisma's `Language` enum (`EN`/`RW`) to the lowercase ISO codes Google's API expects. */
const LANGUAGE_CODE: Record<Language, string> = { EN: 'en', RW: 'rw' };

/**
 * Real Google Cloud Translation API v2 (Basic) client, used when
 * TRANSLATE_PROVIDER=google. One request per batch — the API accepts
 * multiple `q` values and returns their translations in the same order, so
 * a product's name+description (or a whole backfill page) is a single call.
 * `source` is always sent explicitly rather than left to auto-detect: the
 * caller already knows which language the text was authored in (which field
 * the edit came in on), and auto-detecting a short product name/room name
 * is exactly the kind of input Google's language detection gets wrong most
 * often.
 *
 * On any failure this returns `null` for every string (never falling back to
 * the original text) — a save should never fail just because the
 * translation call did, but writing untranslated text into the target
 * column would look exactly like a real translation forever after. The
 * field simply stays untranslated until the next edit or a re-run of the
 * backfill script.
 */
@Injectable()
export class GoogleTranslationProvider implements TranslationProvider {
  private readonly logger = new Logger(GoogleTranslationProvider.name);
  private readonly apiKey: string;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('translate.googleApiKey') ?? '';
    if (!this.apiKey) {
      this.logger.warn('TRANSLATE_PROVIDER=google but GOOGLE_TRANSLATE_API_KEY is not set.');
    }
  }

  async translate(texts: string[], source: Language, target: Language): Promise<(string | null)[]> {
    if (texts.length === 0) return [];
    if (!this.apiKey) return texts.map(() => null);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${GOOGLE_TRANSLATE_API_URL}?key=${this.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: texts,
          source: LANGUAGE_CODE[source],
          target: LANGUAGE_CODE[target],
          format: 'text',
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Never log the response body here — Google's error payload can echo the key back.
        this.logger.error(`Google Translate API error: HTTP ${response.status}`);
        return texts.map(() => null);
      }

      const payload = (await response.json()) as {
        data?: { translations?: { translatedText?: string }[] };
      };
      const translations = payload.data?.translations;
      if (!translations || translations.length !== texts.length) {
        this.logger.error('Google Translate API returned an unexpected shape.');
        return texts.map(() => null);
      }

      return translations.map((row) => row.translatedText ?? null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Google Translate API call failed: ${message}`);
      return texts.map(() => null);
    } finally {
      clearTimeout(timeout);
    }
  }
}
