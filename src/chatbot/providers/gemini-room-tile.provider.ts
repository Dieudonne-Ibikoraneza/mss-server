import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GeneratedImage } from './recommendation-image.provider';
import type { RoomTileEditInput, RoomTileEditProvider } from './room-tile-provider.interface';
import { callGeminiImageModel } from './gemini-image-client';

const MAX_DESCRIPTION_CHARS = 500;

/**
 * Edits the customer's own room photo in place — as opposed to
 * `GeminiImageProvider`, which generates a brand-new room scene from a text
 * brief. Both attached photos go to the same Gemini image model in one call:
 * the room photo first (what's being edited), the tile photo second (the
 * visual reference), with the prompt telling it which is which.
 */
@Injectable()
export class GeminiRoomTileProvider implements RoomTileEditProvider {
  private readonly logger = new Logger(GeminiRoomTileProvider.name);
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: ConfigService) {
    this.apiKey =
      config.get<string>('ai.image.apiKey') ?? config.get<string>('ai.chat.apiKey') ?? '';
    this.model = config.get<string>('ai.image.model') ?? 'gemini-3.1-flash-lite-image';
  }

  async generate(input: RoomTileEditInput): Promise<GeneratedImage | null> {
    if (!this.apiKey) {
      this.logger.warn('Gemini image generation is enabled but no API key is configured.');
      return null;
    }

    const description = input.product.description
      ? ` — ${input.product.description.slice(0, MAX_DESCRIPTION_CHARS)}`
      : '';

    return callGeminiImageModel(this.logger, this.apiKey, this.model, [
      {
        text: `Edit the FIRST attached photo, a real photo of the customer's own room. Replace ONLY the floor surface with the tile shown in the SECOND attached photo — ${input.product.name} (${input.product.collection}, ${input.product.size})${description}. This tile's real, exact physical size is ${input.product.size} — a known fact, not a guess. Use this exact size, scaled against the real room's own furniture, doorways, and walls in the first photo, to decide how large each individual tile and its grout lines should appear on the floor; never infer the tile's size from the second photo's crop or aspect ratio, since that photo shows only its color, pattern, and finish. Treat the tile as a repeating flooring material, not as one large image or a single decal: cover the entire visible floor with a creative, believable layout of many individual tiles, with repeated patterns, clear but realistic grout lines, correct perspective, and tile edges that recede toward the distance. Do not place only one or two oversized tiles at the bottom of the room, do not stretch the reference image across the floor, and do not turn it into a seamless slab. Be attentive and deliberate about getting the tile count, spacing, proportion, and perspective right rather than eyeballing it. Keep the exact same room in the result: the same walls, furniture, windows, ceiling, lighting, camera angle, and perspective as the first photo — this is a photo edit, not a newly generated scene. If the source photo is blurry, noisy, poorly exposed, or otherwise low quality, improve it to a clean, sharp, high-definition-looking result with natural detail, balanced lighting, and realistic colors, but do not invent or alter room features to do so. Reproduce the tile's true color, pattern, and finish exactly as shown in the second photo, at the real size stated above. Do not add text, labels, watermarks, swatches, or a collage; return one edited photo of the room only.`,
      },
      { inlineData: { mimeType: input.roomImage.mimeType, data: input.roomImage.data } },
      { inlineData: { mimeType: input.tileImage.mimeType, data: input.tileImage.data } },
    ]);
  }
}
