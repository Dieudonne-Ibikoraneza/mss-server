export const RECOMMENDATION_IMAGE_PROVIDER = Symbol('RECOMMENDATION_IMAGE_PROVIDER');

export interface RecommendationImageInput {
  /** The conversation context, including the room and style details supplied by the customer. */
  customerBrief: string;
  product: {
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
