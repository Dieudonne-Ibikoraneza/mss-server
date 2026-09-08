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
        text: `Edit the FIRST attached photo, a real photo of the customer's own room. Replace ONLY the floor surface with the tile shown in the SECOND attached photo — ${input.product.name} (${input.product.collection}, ${input.product.size})${description}. Keep the exact same room in the result: the same walls, furniture, windows, ceiling, lighting, camera angle, and perspective as the first photo — this is a photo edit, not a newly generated scene. Reproduce the tile's true color, pattern, scale, and finish exactly as shown in the second photo. Do not add text, labels, watermarks, swatches, or a collage; return one edited photo of the room only.`,
      },
      { inlineData: { mimeType: input.roomImage.mimeType, data: input.roomImage.data } },
      { inlineData: { mimeType: input.tileImage.mimeType, data: input.tileImage.data } },
    ]);
  }
}
