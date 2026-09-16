import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  RecommendationImageInput,
  RecommendationImageProvider,
  GeneratedImage,
} from './recommendation-image.provider';
import { callGeminiImageModel, downloadReferenceImage } from './gemini-image-client';

const MAX_BRIEF_CHARS = 6_000;

/** Tells the model the tile's real physical dimensions are given data, not
 * something to infer from the reference photo — without this it visibly
 * guesses (and gets wrong) how large a tile like "25×40cm" actually is
 * relative to the room, doors, and fixtures. */
const sizeInstruction = (label: string, size: string) =>
  `The ${label}'s real, exact physical size is ${size} — this is a known fact, not a guess. Use this exact size (not an assumed or approximate one) to work out the tile's scale and proportion in the scene: how large each tile looks next to doors, fixtures, and other real-world references, and how many tiles and grout lines span the surface. Never infer the tile's size from its reference photo's aspect ratio or crop — that photo shows only the pattern, color, and finish, not the true size.`;

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

    const wallReference = input.wallProduct
      ? await downloadReferenceImage(input.wallProduct.imageUrl)
      : null;
    if (input.wallProduct && !wallReference) {
      this.logger.warn(`Could not download wall tile reference for ${input.wallProduct.name}.`);
    }

    if (wallReference && input.wallProduct) {
      return callGeminiImageModel(this.logger, this.apiKey, this.model, [
        {
          text: `Create a photorealistic interior-design visualization of a bathroom for this two-tile recommendation.
Customer brief: ${input.customerBrief.slice(-MAX_BRIEF_CHARS)}
Floor tile (FIRST attached photo): ${input.product.name} (${input.product.collection}, ${input.product.size}). ${input.product.description ?? ''}
${sizeInstruction('floor tile', input.product.size)}
Wall tile (SECOND attached photo): ${input.wallProduct.name} (${input.wallProduct.collection}, ${input.wallProduct.size}). ${input.wallProduct.description ?? ''}
${sizeInstruction('wall tile', input.wallProduct.size)}

Tile the entire visible floor with the FIRST tile. Tile the wall with the SECOND tile only up to a common half-height wainscot proportion — roughly the lower half of the wall (about 1.2–1.5m up from the floor), with a clean, straight edge (e.g. a trim/bullnose line) where the tiled wall meets the plain painted wall above it. Do not tile the full wall height. Preserve each tile's true color, pattern, and finish exactly as shown in its reference photo, but its on-screen scale must come from its stated real size above, never from the reference photo's proportions. Be attentive and deliberate about this: the floor tile and wall tile have their own distinct real sizes, and mixing them up or eyeballing either one is a mistake. Include the customer's requested room layout, fixtures, lighting, and mood as described in the brief, and make sure the finished room genuinely matches that brief. Do not show a product-card, text, labels, logos, swatches, or a collage; generate one finished bathroom scene only.`,
        },
        { inlineData: { mimeType: reference.mimeType, data: reference.data } },
        { inlineData: { mimeType: wallReference.mimeType, data: wallReference.data } },
      ]);
    }

    return callGeminiImageModel(this.logger, this.apiKey, this.model, [
      {
        text: `Create a photorealistic interior-design visualization for this tile recommendation.
Customer brief: ${input.customerBrief.slice(-MAX_BRIEF_CHARS)}
Recommended tile: ${input.product.name} (${input.product.collection}, ${input.product.size}).
Tile description: ${input.product.description ?? 'No additional description.'}
${sizeInstruction('tile', input.product.size)}

Use the attached tile photo as the exact visual reference for the recommended tile's color, pattern, and finish only — never for its size. Show it installed naturally on the most relevant floor or wall surfaces in the room the customer described, tiled at its real size as stated above. Include the customer's requested room type, palette, layout, lighting, mood, and other details. Do not show a product-card, text, labels, logos, swatches, or a collage; generate one finished room scene only.`,
      },
      { inlineData: { mimeType: reference.mimeType, data: reference.data } },
    ]);
  }
}
