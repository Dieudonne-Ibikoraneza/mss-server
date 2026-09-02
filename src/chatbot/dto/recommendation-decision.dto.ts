import { IsEnum } from 'class-validator';
import { RecommendationDecision } from '@prisma/client';

/** Customer feedback on one recommendation — liked (ACCEPTED), disliked (REJECTED), or cleared back to PENDING. */
export class RecommendationDecisionDto {
  @IsEnum(RecommendationDecision)
  decision: RecommendationDecision;
}
