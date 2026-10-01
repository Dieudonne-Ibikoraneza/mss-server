import { IsEnum, IsOptional, IsString } from 'class-validator';
import { QueryAnalyticsTableDto } from './query-analytics.dto';
import { AnalyticsPeriod } from '@/common/utils/analytics-period';

export enum TileAnalyticsSort {
  VIEWED_ASC = 'viewed_asc',
  VIEWED_DESC = 'viewed_desc',
  APPLIED_ASC = 'applied_asc',
  APPLIED_DESC = 'applied_desc',
  RECOMMENDED_ASC = 'recommended_asc',
  RECOMMENDED_DESC = 'recommended_desc',
  SAVED_ASC = 'saved_asc',
  SAVED_DESC = 'saved_desc',
  PURCHASED_ASC = 'purchased_asc',
  PURCHASED_DESC = 'purchased_desc',
  SELECTION_RATE_ASC = 'selectionRate_asc',
  SELECTION_RATE_DESC = 'selectionRate_desc',
  NAME_ASC = 'name_asc',
  NAME_DESC = 'name_desc',
}

/**
 * The tiles and AI-recommendation dashboards each need a period (for the
 * leaderboards/rate summary), plus the pagination/search their per-product
 * table already took — one DTO for the merged endpoint instead of two.
 */
export class QueryTilesDto extends QueryAnalyticsTableDto {
  @IsOptional()
  @IsEnum(AnalyticsPeriod)
  period?: AnalyticsPeriod = AnalyticsPeriod.MONTHLY;

  @IsOptional()
  @IsEnum(TileAnalyticsSort)
  sort?: TileAnalyticsSort;

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
