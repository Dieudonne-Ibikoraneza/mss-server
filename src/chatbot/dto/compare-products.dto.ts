import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/** The compare screen shows a handful of products side by side; nothing needs more. */
export const MAX_COMPARED_PRODUCTS = 4;

export class CompareProductsDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(MAX_COMPARED_PRODUCTS)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  productIds: string[];

  @IsString()
  @MaxLength(100)
  sessionId: string;
}
