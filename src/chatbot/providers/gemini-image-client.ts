import type { Logger } from '@nestjs/common';
import type { GeneratedImage } from './recommendation-image.provider';
import { fetchPublicFile } from '@/common/utils/safe-url';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const REQUEST_TIMEOUT_MS = 90_000;

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

/**
 * Shared low-level Gemini image-generation call — `GeminiImageProvider`
 * (recommendation visuals, one tile reference photo) and
 * `GeminiRoomTileProvider` (the customer's own room photo edited with a
 * tile, two reference photos) each build a different prompt and pass a
 * different number of images, but hit the same endpoint the same way and
 * parse the same response shape.
 */
export async function callGeminiImageModel(
  logger: Logger,
  apiKey: string,
  model: string,
  parts: GeminiPart[],
): Promise<GeneratedImage | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['IMAGE'] },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Response body here is Google's own error payload (no request data,
      // no API key) — safe to log, and it's what actually distinguishes a
      // quota-exhausted/billing-not-enabled failure from a transient one.
      const errorBody = await response.text().catch(() => '');
      logger.error(`Gemini image API error: HTTP ${response.status} — ${errorBody.slice(0, 500)}`);
      return null;
    }

    const payload = (await response.json()) as {
      candidates?: {
        content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
      }[];
    };
    const image = payload.candidates?.[0]?.content?.parts?.find(
      (part) => part.inlineData?.data,
    )?.inlineData;
    return image?.data ? { data: image.data, mimeType: image.mimeType ?? 'image/png' } : null;
  } catch (error) {
    logger.error(
      `Gemini image call failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Downloads an external image (e.g. a catalog tile's resolved signed URL) as
 * base64 for handing to the image model — shared by both providers above. */
export async function downloadReferenceImage(
  url: string,
): Promise<{ mimeType: string; data: string } | null> {
  // The URL can come from a catalog editor, so it is never trusted: `fetchPublicFile` only talks
  // to public addresses, connects to the address it checked, and refuses redirects.
  const file = await fetchPublicFile(url, { timeoutMs: 15_000, maxBytes: 10 * 1024 * 1024 });
  if (!file || file.buffer.length === 0) return null;
  const contentType = file.contentType || 'image/jpeg';
  if (!contentType.startsWith('image/')) return null;
  return { mimeType: contentType, data: file.buffer.toString('base64') };
}
