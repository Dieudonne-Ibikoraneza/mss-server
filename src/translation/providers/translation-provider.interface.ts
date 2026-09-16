import type { Language } from '@prisma/client';

export const TRANSLATION_PROVIDER = Symbol('TRANSLATION_PROVIDER');

/**
 * The one thing every translation backend needs to do: turn a batch of
 * strings written in `source` into their `target`-language equivalents, in
 * the same order. Batched (not one string at a time) so a real provider call
 * is one HTTP request per save/backfill run, not one per field.
 *
 * Both directions are real: a product edited from the English admin UI is
 * EN→RW same as always, but a product edited from the Kinyarwanda UI is
 * RW→EN — the *English* column is the one regenerated in that case. Callers
 * decide the direction from which language the edit was actually authored
 * in, never assume EN→RW.
 *
 * A `null` entry means "not translated" (no provider configured, or this
 * one call failed) — callers must leave the corresponding column alone
 * rather than write anything in its place. Falling back to the original
 * text there would look exactly like a real translation to every future
 * read and to any later re-run trying to fill the gap, so it's never a safe
 * default.
 */
export interface TranslationProvider {
  translate(texts: string[], source: Language, target: Language): Promise<(string | null)[]>;
}
