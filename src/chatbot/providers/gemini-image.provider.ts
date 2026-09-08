import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  RecommendationImageInput,
  RecommendationImageProvider,
  GeneratedImage,
} from './recommendation-image.provider';
import { callGeminiImageModel, downloadReferenceImage } from './gemini-image-client';

const MAX_BRIEF_CHARS = 6_000;

/** Gemini's image model returns the rendered image as inlineData — handed back
 * as raw base64 bytes, not a `data:` URL, so the caller (`ChatbotService`) can
 * both render it immediately on the live turn *and* persist it to storage for
 * a reloaded conversation, without generating it twice. */
@Injectable()
export class GeminiImageProvider implements RecommendationImageProvider {
  private readonly logger = new Logger(GeminiImageProvider.name);
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: ConfigService) {
    this.apiKey =
      config.get<string>('ai.image.apiKey') ?? config.get<string>('ai.chat.apiKey') ?? '';
    this.model = config.get<string>('ai.image.model') ?? 'gemini-3.1-flash-lite-image';
  }

  async generate(input: RecommendationImageInput): Promise<GeneratedImage | null> {
    if (!this.apiKey) {
      this.logger.warn('Gemini image generation is enabled but no API key is configured.');
      return null;
    }

    const reference = await downloadReferenceImage(input.product.imageUrl);
    if (!reference) {
      this.logger.warn(`Could not download tile reference for ${input.product.name}.`);
      return null;
    }

    return callGeminiImageModel(this.logger, this.apiKey, this.model, [
      {
        text: `Create a photorealistic interior-design visualization for this tile recommendation.
Customer brief: ${input.customerBrief.slice(-MAX_BRIEF_CHARS)}
Recommended tile: ${input.product.name} (${input.product.collection}, ${input.product.size}).
Tile description: ${input.product.description ?? 'No additional description.'}

Use the attached tile photo as the exact visual reference for the recommended tile. Show it installed naturally on the most relevant floor or wall surfaces in the room the customer described. Preserve its true color, pattern, scale, and finish. Include the customer's requested room type, palette, layout, lighting, mood, and other details. Do not show a product-card, text, labels, logos, swatches, or a collage; generate one finished room scene only.`,
      },
      { inlineData: { mimeType: reference.mimeType, data: reference.data } },
    ]);
  }
}
