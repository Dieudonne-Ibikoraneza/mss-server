import { IsNumber, IsOptional, IsPositive, IsUUID, Max, Min } from 'class-validator';

export class FloorPlanDto {
  @IsUUID()
  productId: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  length?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  width?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  totalAreaSqm?: number;

  /** Wastage allowance as a percentage, e.g. 10 for 10%. Defaults to 10%. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(50)
  wastagePercent?: number = 10;
}
