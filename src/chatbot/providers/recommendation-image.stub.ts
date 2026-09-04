import { Injectable } from '@nestjs/common';
import type {
  RecommendationImageProvider,
  RecommendationImageInput,
} from './recommendation-image.provider';

@Injectable()
export class StubRecommendationImageProvider implements RecommendationImageProvider {
  generate(_input: RecommendationImageInput): Promise<string | null> {
    return Promise.resolve(null);
  }
}
