import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * Not a `productId: UUID` on purpose — the storefront cart this comes from
 * isn't wired to live product records yet (see `CartNegotiationItem`), so
 * this takes the cart's own snapshot of what the customer was trying to buy.
 */
export class CartNegotiationItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  productId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  productName: string;

  /** What the customer had entered in the cart, in m² — the amount that didn't fit. */
  @IsNumber()
  @IsPositive()
  requestedAreaSqm: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  availabilityNote: string;
}

export class CreateCartNegotiationDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CartNegotiationItemDto)
  items: CartNegotiationItemDto[];

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  body: string;
}
