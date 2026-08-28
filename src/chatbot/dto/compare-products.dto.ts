import { ArrayMinSize, IsArray, IsString, IsUUID } from 'class-validator';

export class CompareProductsDto {
  @IsArray()
  @ArrayMinSize(2)
  @IsUUID(undefined, { each: true })
  productIds: string[];

  @IsString()
  sessionId: string;
}
