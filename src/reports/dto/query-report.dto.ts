import { IsEnum, IsOptional } from 'class-validator';
import { AnalyticsPeriod } from '@/common/utils/analytics-period';

export class QueryReportDto {
  @IsOptional()
  @IsEnum(AnalyticsPeriod)
  period?: AnalyticsPeriod = AnalyticsPeriod.MONTHLY;
}
