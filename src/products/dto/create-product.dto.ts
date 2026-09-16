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

  /** Selling price per square metre (m²) — what the client is shown and pays. */
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

  /**
   * Set when the edit was authored in the Kinyarwanda admin UI — the
   * client sends the Kinyarwanda text here (not in `name`, which stays the
   * English column always) so the service knows to translate RW -> EN and
   * regenerate `name`/`description` instead of the usual EN -> RW.
   * Never sent together with `name`/`description` by the app's own edit
   * dialogs, but nothing stops a future caller from providing both.
   */
  @IsOptional()
  @IsString()
  @MinLength(2)
  nameRw?: string;

  @IsOptional()
  @IsString()
  descriptionRw?: string;

  @IsEnum(SuitableFor)
  suitableFor: SuitableFor;

  @IsArray()
  @IsEnum(RoomType, { each: true })
  roomTypes: RoomType[];

  /** Opening stock in square metres — boxes/pieces are a display conversion only. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  initialAreaSqm?: number;

  /**
   * What we paid per square metre for the initial stock (what feeds the
   * average cost used for inventory valuation — never shown to clients).
   * Required when `initialAreaSqm` is greater than 0, since there's no prior
   * average to fall back on; ignored/omit when there's no opening stock yet.
   */
  @ValidateIf((dto: CreateProductDto) => (dto.initialAreaSqm ?? 0) > 0)
  @IsNumber()
  @IsPositive()
  initialCostPrice?: number;
}
