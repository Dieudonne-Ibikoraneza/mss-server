import { StockMovementType } from '@prisma/client';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

export class AdjustStockDto {
  /**
   * Signed change in square metres: positive to add stock, negative to
   * remove it. Boxes/pieces are only ever a conversion for display —
   * adjustments are always entered and stored in m².
   */
  @IsNumber()
  changeAreaSqm: number;

  /**
   * How the stock moved, for the movement report. Defaults from the sign of
   * `changeAreaSqm` when omitted: stock coming in is INBOUND, stock going out
   * is OUTBOUND. Send ADJUSTMENT explicitly for corrections (recount, damage).
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
   * What we paid per square metre for this incoming batch. Only meaningful
   * when stock is coming in (`changeAreaSqm` > 0) — feeds the moving
   * weighted-average cost used for inventory valuation. Omit for outbound
   * movements or corrections with no known cost; the average is left
   * untouched when omitted.
   */
  @IsOptional()
  @IsNumber()
  @IsPositive()
  costPrice?: number;
}
