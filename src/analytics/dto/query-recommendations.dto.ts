import { IsEnum, IsOptional, IsString } from 'class-validator';
import { AnalyticsPeriod } from '@/common/utils/analytics-period';
import { QueryAnalyticsTableDto } from './query-analytics.dto';

export enum RecommendationAnalyticsSort {
  DISPLAYED_DESC = 'displayed_desc',
  DISPLAYED_ASC = 'displayed_asc',
  ACCEPTED_DESC = 'accepted_desc',
  ACCEPTED_ASC = 'accepted_asc',
  ACCEPTANCE_RATE_DESC = 'acceptanceRate_desc',
  ACCEPTANCE_RATE_ASC = 'acceptanceRate_asc',
  MATCH_SCORE_DESC = 'averageMatchScore_desc',
  MATCH_SCORE_ASC = 'averageMatchScore_asc',
  NAME_ASC = 'name_asc',
  NAME_DESC = 'name_desc',
}

/** Server-owned paging/filtering for the per-product AI analytics table. CSV fields support the UI's multi-select filters. */
export class QueryRecommendationsDto extends QueryAnalyticsTableDto {
  @IsOptional()
  @IsEnum(AnalyticsPeriod)
  period?: AnalyticsPeriod = AnalyticsPeriod.MONTHLY;

  @IsOptional()
  @IsEnum(RecommendationAnalyticsSort)
  sort?: RecommendationAnalyticsSort = RecommendationAnalyticsSort.DISPLAYED_DESC;

  @IsOptional()
  @IsString()
  roomTypes?: string;

  @IsOptional()
  @IsString()
  suitableFor?: string;

  @IsOptional()
  @IsString()
  sizes?: string;

  @IsOptional()
  @IsString()
  stockStatuses?: string;
}
