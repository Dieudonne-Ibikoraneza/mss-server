import { ArrayNotEmpty, IsArray, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { OrderItemInputDto } from './create-order.dto';

/** The stock team can revise the quantities agreed during an order negotiation. */
export class UpdateOrderItemsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items: OrderItemInputDto[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
