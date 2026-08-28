import { StockMovementType } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

export class AdjustStockDto {
  /** Signed change in pieces: positive to add stock, negative to remove it. */
  @IsInt()
  changeQty: number;

  /**
   * How the stock moved, for the movement report. Defaults from the sign of
   * `changeQty` when omitted: stock coming in is INBOUND, stock going out is
   * OUTBOUND. Send ADJUSTMENT explicitly for corrections (recount, damage).
   */
  @IsOptional()
  @IsEnum(StockMovementType)
  type?: StockMovementType;

  /** Document this movement traces back to, e.g. "PO-2026-089". */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  reference?: string;

  @IsString()
  @IsNotEmpty()
  reason: string;

  /**
   * What we paid per box for this incoming batch. Only meaningful when stock
   * is coming in (`changeQty` > 0) — feeds the moving weighted-average cost
   * used for inventory valuation. Omit for outbound movements or corrections
   * with no known cost; the average is left untouched when omitted.
   */
  @IsOptional()
  @IsNumber()
  @IsPositive()
  costPrice?: number;
}
