import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  RecommendationImageInput,
  RecommendationImageProvider,
} from './recommendation-image.provider';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_BRIEF_CHARS = 6_000;

/** Gemini's image model returns the rendered image as inlineData. Keeping it as a
 * data URL makes the recommendation response self-contained and avoids leaking
 * the server's storage credentials or adding a second image-upload round trip. */
@Injectable()
export class GeminiImageProvider implements RecommendationImageProvider {
  private readonly logger = new Logger(GeminiImageProvider.name);
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: ConfigService) {
    this.apiKey =
      config.get<string>('ai.image.apiKey') ?? config.get<string>('ai.chat.apiKey') ?? '';
    this.model = config.get<string>('ai.image.model') ?? 'gemini-2.5-flash-image';
  }

  async generate(input: RecommendationImageInput): Promise<string | null> {
    if (!this.apiKey) {
      this.logger.warn('Gemini image generation is enabled but no API key is configured.');
      return null;
    }

    const reference = await this.downloadReferenceImage(input.product.imageUrl);
    if (!reference) {
      this.logger.warn(`Could not download tile reference for ${input.product.name}.`);
      return null;
    }

    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `Create a photorealistic interior-design visualization for this tile recommendation.
Customer brief: ${input.customerBrief.slice(-MAX_BRIEF_CHARS)}
Recommended tile: ${input.product.name} (${input.product.collection}, ${input.product.size}).
Tile description: ${input.product.description ?? 'No additional description.'}

Use the attached tile photo as the exact visual reference for the recommended tile. Show it installed naturally on the most relevant floor or wall surfaces in the room the customer described. Preserve its true color, pattern, scale, and finish. Include the customer's requested room type, palette, layout, lighting, mood, and other details. Do not show a product-card, text, labels, logos, swatches, or a collage; generate one finished room scene only.`,
            },
            { inlineData: { mimeType: reference.mimeType, data: reference.data } },
          ],
        },
      ],
      generationConfig: { responseModalities: ['IMAGE'] },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${GEMINI_API_BASE}/${this.model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Response body here is Google's own error payload (no request data,
        // no API key) — safe to log, and it's what actually distinguishes a
        // quota-exhausted/billing-not-enabled failure from a transient one.
        const errorBody = await response.text().catch(() => '');
        this.logger.error(
          `Gemini image API error: HTTP ${response.status} — ${errorBody.slice(0, 500)}`,
        );
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
      return image?.data ? `data:${image.mimeType ?? 'image/png'};base64,${image.data}` : null;
    } catch (error) {
      this.logger.error(
        `Gemini image call failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async downloadReferenceImage(
    url: string,
  ): Promise<{ mimeType: string; data: string } | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return null;
      const contentType = response.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg';
      if (!contentType.startsWith('image/')) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0 || buffer.length > 10 * 1024 * 1024) return null;
      return { mimeType: contentType, data: buffer.toString('base64') };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
