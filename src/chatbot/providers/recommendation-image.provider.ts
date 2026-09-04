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

export interface RecommendationImageProvider {
  generate(input: RecommendationImageInput): Promise<string | null>;
}
