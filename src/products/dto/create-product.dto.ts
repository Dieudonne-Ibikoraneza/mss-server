import { RoomType, SuitableFor } from '@prisma/client';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreateProductDto {
  @IsString()
  @MinLength(2)
  name: string;

  @IsString()
  sku: string;

  @IsUUID()
  collectionId: string;

  /** Total sqm covered by one box — depends on packaging, so it's per-product, not per-collection. */
  @IsNumber()
  @IsPositive()
  boxCoverageSqm: number;

  @IsInt()
  @IsPositive()
  piecesPerBox: number;

  /** Selling price per box — what the client is shown and pays. */
  @IsNumber()
  @IsPositive()
  price: number;

  /** The catalog shows exactly one image per product — not a gallery. */
  @IsString()
  @MinLength(1)
  image: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(SuitableFor)
  suitableFor: SuitableFor;

  @IsArray()
  @IsEnum(RoomType, { each: true })
  roomTypes: RoomType[];

  @IsOptional()
  @IsInt()
  @Min(0)
  initialQuantity?: number;

  /**
   * What we paid per box for the initial stock (what feeds the average cost
   * used for inventory valuation — never shown to clients). Required when
   * `initialQuantity` is greater than 0, since there's no prior average to
   * fall back on; ignored/omit when there's no opening stock yet.
   */
  @ValidateIf((dto: CreateProductDto) => (dto.initialQuantity ?? 0) > 0)
  @IsNumber()
  @IsPositive()
  initialCostPrice?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  lowStockThreshold?: number;
}
