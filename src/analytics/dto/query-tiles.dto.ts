import { IsEnum, IsOptional } from 'class-validator';
import { QueryAnalyticsTableDto } from './query-analytics.dto';
import { AnalyticsPeriod } from '@/common/utils/analytics-period';

export enum TileAnalyticsSort {
  APPLIED_ASC = 'applied_asc',
  APPLIED_DESC = 'applied_desc',
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
}
