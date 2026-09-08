import { Injectable } from '@nestjs/common';
import type {
  RecommendationImageProvider,
  RecommendationImageInput,
  GeneratedImage,
} from './recommendation-image.provider';

@Injectable()
export class StubRecommendationImageProvider implements RecommendationImageProvider {
  generate(_input: RecommendationImageInput): Promise<GeneratedImage | null> {
    return Promise.resolve(null);
  }
}
