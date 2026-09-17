import { IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class CheckSkuDto {
  @IsString()
  @MinLength(1)
  sku: string;

  /** The product's own id — pass this when checking from an edit dialog so the product doesn't collide with itself. */
  @IsOptional()
  @IsUUID()
  excludeId?: string;
}
