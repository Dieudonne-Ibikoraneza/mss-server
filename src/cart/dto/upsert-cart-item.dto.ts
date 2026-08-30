import { IsNumber, IsPositive, IsUUID, Max } from 'class-validator';
import { MAX_ORDER_AREA_SQM } from '@/common/utils/tile-calculator';

export class UpsertCartItemDto {
  @IsUUID()
  productId: string;

  @IsNumber()
  @IsPositive()
  @Max(MAX_ORDER_AREA_SQM)
  areaSqm: number;
}
