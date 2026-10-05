import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GeneratedImage } from './recommendation-image.provider';
import type { RoomTileEditInput, RoomTileEditProvider } from './room-tile-provider.interface';
import { callGeminiImageModel } from './gemini-image-client';
import { tileInstallationInstructions, TILE_PATTERN_CHECK } from './tile-rendering-prompt';
import { createTileRepeatReference, repeatReferenceInstructions } from './tile-repeat-reference';

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
    const repeatReference = await createTileRepeatReference(input.tileImage, input.product);

    return callGeminiImageModel(this.logger, this.apiKey, this.model, [
      {
        text: `Edit the FIRST attached photo, the customer's own room. Replace ONLY the visible floor surface with the actual catalog tile in the SECOND attached photo — ${input.product.name} (${input.product.collection}, ${input.product.size})${description}.
${tileInstallationInstructions(input.product, 'floor tile')}
${repeatReference ? repeatReferenceInstructions(input.product, 'The THIRD attached image (installation proof)') : ''}

The FIRST photo determines room geometry, occlusion, perspective, camera position, and lighting. The SECOND determines the artwork inside each repeated tile. Match the catalog module size against room furniture and doors. Cover the visible floor with correctly sized complete tiles and cut edge tiles; never enlarge one tile or its printed bands to span the room. Keep furniture, rugs, walls, windows, doors, ceiling, and their positions unchanged. Tiles must remain behind furniture and rugs, with realistic contact shadows; do not paint over those objects or change the camera to make tiling easier. Improve poor exposure or noise only without altering room features.
${TILE_PATTERN_CHECK} Do not add text, labels, watermarks, swatches, or a collage; return one edited photo of the same room only.`,
      },
      { inlineData: { mimeType: input.roomImage.mimeType, data: input.roomImage.data } },
      { inlineData: { mimeType: input.tileImage.mimeType, data: input.tileImage.data } },
      ...(repeatReference ? [{ inlineData: repeatReference }] : []),
    ]);
  }
}
