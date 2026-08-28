export interface GenerateImagePreviewInput {
  roomImageUrl?: string;
  productIds: string[];
}

export interface GenerateVideoPreviewInput {
  roomVideoUrl: string;
  productIds: string[];
}

export interface MediaGenerationResult {
  outputUrl: string;
}

export interface ImagePreviewProvider {
  generate(input: GenerateImagePreviewInput): Promise<MediaGenerationResult>;
}

export interface VideoPreviewProvider {
  generate(input: GenerateVideoPreviewInput): Promise<MediaGenerationResult>;
}
