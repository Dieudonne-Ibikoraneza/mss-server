import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  ValidateNested,
} from 'class-validator';
import { OrderType } from '@prisma/client';
import { MAX_ORDER_AREA_SQM } from '@/common/utils/tile-calculator';

export class OrderItemInputDto {
  @IsUUID()
  productId: string;

  @IsNumber()
  @IsPositive()
  @Max(MAX_ORDER_AREA_SQM)
  areaSqm: number;
}

export class CreateOrderDto {
  @IsEnum(OrderType)
  type: OrderType;

  /** Only staff (sales person, stock manager, admin) may set this to create an order on behalf of a customer. */
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items: OrderItemInputDto[];

  @IsOptional()
  @IsString()
  notes?: string;
}
