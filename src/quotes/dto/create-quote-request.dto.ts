import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class QuoteItemInputDto {
  @IsUUID()
  productId: string;

  @IsNumber()
  @IsPositive()
  areaSqm: number;
}

export class CreateQuoteRequestDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => QuoteItemInputDto)
  items: QuoteItemInputDto[];

  @IsOptional()
  @IsString()
  notes?: string;
}
