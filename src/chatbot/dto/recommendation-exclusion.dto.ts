import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '@/common/dto/pagination.dto';

export enum RecommendationEligibility {
  ALL = 'all',
  EXCLUDED = 'excluded',
  ELIGIBLE = 'eligible',
}

export class ListRecommendationTilesDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsEnum(RecommendationEligibility)
  eligibility: RecommendationEligibility = RecommendationEligibility.ALL;
}

export class UpdateRecommendationExclusionDto {
  @IsBoolean()
  recommendationExcluded: boolean;
}
