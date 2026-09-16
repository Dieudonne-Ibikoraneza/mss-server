export const RECOMMENDATION_IMAGE_PROVIDER = Symbol('RECOMMENDATION_IMAGE_PROVIDER');

export interface RecommendationImageInput {
  /** The conversation context, including the room and style details supplied by the customer. */
  customerBrief: string;
  /** The floor tile (or the sole tile, outside a bathroom combo). */
  product: {
    name: string;
    description: string | null;
    collection: string;
    size: string;
    imageUrl: string;
  };
  /** Present only for a bathroom floor+wall combo — a second, different tile
   * to render installed on the lower portion of the wall alongside `product`
   * on the floor, in the same scene. */
  wallProduct?: {
    name: string;
    description: string | null;
    collection: string;
    size: string;
    imageUrl: string;
  };
}

export interface GeneratedImage {
  /** Base64-encoded image bytes — never a `data:` URL. The caller decides
   * whether to render it directly (a live turn, as a data URL) or persist it
   * to storage (so a reloaded conversation doesn't need to regenerate it). */
  data: string;
  mimeType: string;
}

export interface RecommendationImageProvider {
  generate(input: RecommendationImageInput): Promise<GeneratedImage | null>;
}
