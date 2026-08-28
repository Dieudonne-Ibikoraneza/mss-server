import { IsNumber, IsPositive, IsUUID } from 'class-validator';

export class CalculateQuantityDto {
  @IsUUID()
  productId: string;

  @IsNumber()
  @IsPositive()
  areaSqm: number;
}
