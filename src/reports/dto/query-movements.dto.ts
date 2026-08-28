import { StockMovementType } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationDto } from '@/common/dto/pagination.dto';
import { AnalyticsPeriod } from '@/common/utils/analytics-period';

export class QueryMovementsDto extends PaginationDto {
  @IsOptional()
  @IsEnum(AnalyticsPeriod)
  period?: AnalyticsPeriod = AnalyticsPeriod.MONTHLY;

  /** Omit for the "All" tab of the movement feed. */
  @IsOptional()
  @IsEnum(StockMovementType)
  type?: StockMovementType;

  @IsOptional()
  @IsUUID()
  productId?: string;
}
