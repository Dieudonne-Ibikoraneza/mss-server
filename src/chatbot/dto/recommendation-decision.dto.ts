import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsEnum, IsUUID } from 'class-validator';
import { RecommendationDecision } from '@prisma/client';

/** Customer feedback on one recommendation — liked (ACCEPTED), disliked (REJECTED), or cleared back to PENDING. */
export class RecommendationDecisionDto {
  @IsEnum(RecommendationDecision)
  decision: RecommendationDecision;
}

/**
 * One reaction to a whole card — a bathroom card is a floor pick and a wall pick, each its own
 * recommendation. Sent as one request so the card's picks are saved together or not at all.
 */
export class RecommendationBatchDecisionDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  recommendationIds: string[];

  @IsEnum(RecommendationDecision)
  decision: RecommendationDecision;
}
