import { IsNumber, IsPositive, IsUUID } from 'class-validator';

export class UpsertCartItemDto {
  @IsUUID()
  productId: string;

  @IsNumber()
  @IsPositive()
  areaSqm: number;
}
