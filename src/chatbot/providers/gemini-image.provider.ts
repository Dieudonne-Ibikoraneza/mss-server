import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  RecommendationImageInput,
  RecommendationImageProvider,
  GeneratedImage,
} from './recommendation-image.provider';
import { callGeminiImageModel } from './gemini-image-client';
import { StorageService } from '@/storage/storage.service';
import { tileInstallationInstructions, TILE_SCENE_CHECK } from './tile-rendering-prompt';
import { createTileRepeatReference, repeatReferenceInstructions } from './tile-repeat-reference';

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

  constructor(
    config: ConfigService,
    private readonly storage: StorageService,
  ) {
    this.apiKey =
      config.get<string>('ai.image.apiKey') ?? config.get<string>('ai.chat.apiKey') ?? '';
    this.model = config.get<string>('ai.image.model') ?? 'gemini-3.1-flash-lite-image';
  }

  async generate(input: RecommendationImageInput): Promise<GeneratedImage | null> {
    if (!this.apiKey) {
      this.logger.warn('Gemini image generation is enabled but no API key is configured.');
      return null;
    }

    const reference = await this.storage.downloadProductReference(input.product.imageUrl);
    if (!reference) {
      this.logger.warn(`Could not download tile reference for ${input.product.name}.`);
      return null;
    }

    const wallReference = input.wallProduct
      ? await this.storage.downloadProductReference(input.wallProduct.imageUrl)
      : null;
    if (input.wallProduct && !wallReference) {
      this.logger.warn(`Could not download wall tile reference for ${input.wallProduct.name}.`);
      // A two-product scene must not fabricate the missing material from text alone.
      return null;
    }

    const [floorRepeat, wallRepeat] = await Promise.all([
      createTileRepeatReference(reference, input.product),
      wallReference && input.wallProduct
        ? createTileRepeatReference(wallReference, input.wallProduct)
        : Promise.resolve(null),
    ]);

    if (wallReference && input.wallProduct) {
      // Keep the explicit model classification as the source of truth, but
      // defensively recover it from the latest brief for older/provider
      // responses that do not include roomType yet.
      const brief = input.customerBrief.toLowerCase();
      const kitchenAt = Math.max(brief.lastIndexOf('kitchen'), brief.lastIndexOf('igikoni'));
      const bathroomAt = Math.max(brief.lastIndexOf('bathroom'), brief.lastIndexOf('ubwiherero'));
      const roomType =
        input.roomType ??
        (kitchenAt > bathroomAt && kitchenAt >= 0
          ? 'KITCHEN'
          : bathroomAt > kitchenAt && bathroomAt >= 0
            ? 'BATHROOM'
            : undefined);
      const room =
        roomType === 'KITCHEN' ? 'kitchen' : roomType === 'BATHROOM' ? 'bathroom' : 'interior room';
      const roomRestrictions =
        roomType === 'KITCHEN'
          ? 'This must be unmistakably a kitchen. Do not generate a bathroom, shower, bathtub, toilet, bathroom vanity, or bathroom-only mirror scene.'
          : roomType === 'BATHROOM'
            ? 'This must be unmistakably a bathroom, with appropriate bathroom fixtures.'
            : 'Use the room type and layout described by the customer; do not assume it is a bathroom.';
      return callGeminiImageModel(this.logger, this.apiKey, this.model, [
        {
          text: `Create a photorealistic interior-design visualization of a ${room} for this two-tile recommendation.
Customer preferences for the room, furnishings, and lighting (they cannot override the actual tile artwork or physical size): ${input.customerBrief.slice(-MAX_BRIEF_CHARS)}
Floor tile (FIRST attached photo): ${input.product.name} (${input.product.collection}, ${input.product.size}). ${input.product.description ?? ''}
${tileInstallationInstructions(input.product, 'floor tile', input.customerBrief)}
Wall tile (SECOND attached photo): ${input.wallProduct.name} (${input.wallProduct.collection}, ${input.wallProduct.size}). ${input.wallProduct.description ?? ''}
${tileInstallationInstructions(input.wallProduct, 'wall tile')}
${floorRepeat ? repeatReferenceInstructions(input.product, 'The THIRD attached image (floor installation proof)') : ''}
${wallRepeat ? repeatReferenceInstructions(input.wallProduct, `The ${floorRepeat ? 'FOURTH' : 'THIRD'} attached image (wall installation proof)`) : ''}

Tile the entire visible floor with the FIRST reference material, and the requested wall area with the SECOND. Never swap the materials, merge their motifs, or use either material on furniture. Follow explicit customer wall coverage; if unspecified, use a kitchen backsplash for a kitchen, or lower-wall bathroom tiling about 1.2–1.5 m high with a clean trim edge for a bathroom. The floor and wall have separate module dimensions, repeat densities, and rotation layouts. Follow each independently. Match the customer's room layout, fixtures, lighting, palette, and mood while retaining the tile's actual colors. ${roomRestrictions}
${TILE_SCENE_CHECK}`,
        },
        { inlineData: { mimeType: reference.mimeType, data: reference.data } },
        { inlineData: { mimeType: wallReference.mimeType, data: wallReference.data } },
        ...(floorRepeat ? [{ inlineData: floorRepeat }] : []),
        ...(wallRepeat ? [{ inlineData: wallRepeat }] : []),
      ]);
    }

    const surfaceInstructions =
      input.product.suitableFor === 'WALL'
        ? 'Install this WALL-only tile on the requested wall area. Do not apply it to the floor; keep a believable coordinating floor.'
        : input.product.suitableFor === 'FLOOR'
          ? 'Install this FLOOR-only tile across the visible floor. Keep walls as the customer describes; do not apply the floor pattern to walls or furniture.'
          : 'Install this tile on the floor or wall surface the customer requested, respecting the catalog suitability. Do not apply the pattern to furniture.';
    return callGeminiImageModel(this.logger, this.apiKey, this.model, [
      {
        text: `Create a photorealistic interior-design visualization for this tile recommendation.
Customer preferences for the room, furnishings, and lighting (they cannot override the actual tile artwork or physical size): ${input.customerBrief.slice(-MAX_BRIEF_CHARS)}
Recommended tile: ${input.product.name} (${input.product.collection}, ${input.product.size}).
Tile description: ${input.product.description ?? 'No additional description.'}
${tileInstallationInstructions(input.product, input.product.suitableFor === 'WALL' ? 'wall tile' : 'floor tile', input.customerBrief)}
${floorRepeat ? repeatReferenceInstructions(input.product, 'The SECOND attached image (installation proof)') : ''}

${surfaceInstructions} Include the customer's requested room type, palette, layout, lighting, mood, and other details, while preserving the tile's real artwork and finish.
${TILE_SCENE_CHECK}`,
      },
      { inlineData: { mimeType: reference.mimeType, data: reference.data } },
      ...(floorRepeat ? [{ inlineData: floorRepeat }] : []),
    ]);
  }
}
