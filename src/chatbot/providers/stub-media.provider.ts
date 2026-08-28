import { Injectable, Logger } from '@nestjs/common';
import type {
  GenerateImagePreviewInput,
  GenerateVideoPreviewInput,
  ImagePreviewProvider,
  MediaGenerationResult,
  VideoPreviewProvider,
} from './media-provider.interface';

/**
 * Placeholders for the image model (3.6: "generates preview images of a
 * room styled with selected tiles") and video model (3.6: "accepts a
 * client-submitted video ... returns a version showing the design applied
 * to that space"). Both return the input unchanged until AI_IMAGE_PROVIDER
 * / AI_VIDEO_PROVIDER are pointed at a real model.
 */
@Injectable()
export class StubImagePreviewProvider implements ImagePreviewProvider {
  private readonly logger = new Logger(StubImagePreviewProvider.name);

  generate(input: GenerateImagePreviewInput): Promise<MediaGenerationResult> {
    this.logger.debug(`Stub image preview for products: ${input.productIds.join(', ')}`);
    return Promise.resolve({ outputUrl: input.roomImageUrl ?? '' });
  }
}

@Injectable()
export class StubVideoPreviewProvider implements VideoPreviewProvider {
  private readonly logger = new Logger(StubVideoPreviewProvider.name);

  generate(input: GenerateVideoPreviewInput): Promise<MediaGenerationResult> {
    this.logger.debug(`Stub video preview for products: ${input.productIds.join(', ')}`);
    return Promise.resolve({ outputUrl: input.roomVideoUrl });
  }
}
