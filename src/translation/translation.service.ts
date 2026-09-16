import { Inject, Injectable } from '@nestjs/common';
import type { Language } from '@prisma/client';
import {
  TRANSLATION_PROVIDER,
  type TranslationProvider,
} from './providers/translation-provider.interface';

/**
 * Null-safe, batching front door onto whichever `TranslationProvider` is
 * wired up (see `TranslationModule`) — every product/collection/room/
 * knowledge-base write goes through this rather than the provider directly,
 * so "nothing to translate" and "batch these together" only need handling
 * once.
 */
@Injectable()
export class TranslationService {
  constructor(@Inject(TRANSLATION_PROVIDER) private readonly provider: TranslationProvider) {}

  /**
   * Translates a named set of fields (e.g. `{ name, description }`) in one
   * batched provider call, skipping any that are null/undefined/empty.
   * Returns only the keys that actually had something to translate — spread
   * the result onto the write, don't assume every key comes back.
   *
   * `source`/`target` name the actual direction of this call — pass
   * `RW, EN` for an edit authored in Kinyarwanda (regenerating the English
   * columns), not just `EN, RW` by default. Every call site decides this
   * from which language the edit actually came in on.
   */
  async translateFields<K extends string>(
    fields: Record<K, string | null | undefined>,
    source: Language,
    target: Language,
  ): Promise<Partial<Record<K, string>>> {
    const entries = Object.entries(fields) as [K, string | null | undefined][];
    const toTranslate = entries.filter((entry): entry is [K, string] => !!entry[1]);
    if (toTranslate.length === 0) return {};

    const translated = await this.provider.translate(
      toTranslate.map(([, value]) => value),
      source,
      target,
    );
    const result: Partial<Record<K, string>> = {};
    toTranslate.forEach(([key], index) => {
      const value = translated[index];
      if (value !== null) result[key] = value;
    });
    return result;
  }
}
