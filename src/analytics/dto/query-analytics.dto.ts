import { IsEnum, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '@/common/dto/pagination.dto';
import { AnalyticsPeriod } from '@/common/utils/analytics-period';

/** The reporting window every dashboard's "7 DAYS / 30 DAYS / 12 MONTHS" switcher sends. */
export class QueryAnalyticsDto {
  @IsOptional()
  @IsEnum(AnalyticsPeriod)
  period?: AnalyticsPeriod = AnalyticsPeriod.MONTHLY;
}

/** Paginated, searchable per-product tables on the tiles and AI dashboards. */
export class QueryAnalyticsTableDto extends PaginationDto {
  @IsOptional()
  @IsString()
  search?: string;
}
