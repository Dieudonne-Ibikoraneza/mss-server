import { Type } from 'class-transformer';
import {
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class BaseboardInputDto {
  /** Optional separate allowance for baseboards when floor area is already known. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(50)
  wastagePercent?: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(200)
  heightCm: number;

  /** Required when the room is given only as an area; can override a rectangular perimeter. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  @Max(100_000)
  perimeterM?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(100_000)
  openingsWidthM?: number = 0;

  /** Material lost between strips to the cutting blade. Editable estimate. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10)
  cutWidthMm?: number = 3;
}

export class FloorPlanDto {
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => BaseboardInputDto)
  baseboard?: BaseboardInputDto;

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
