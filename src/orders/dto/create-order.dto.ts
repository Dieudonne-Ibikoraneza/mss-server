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
import { SaveDeliveryDetailsDto } from './save-delivery-details.dto';

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

  /**
   * Generated once per checkout attempt and re-sent on every retry of it. If the
   * first request succeeded but its reply never arrived, the retry gets that
   * same order back instead of creating a second one. Scoped per customer.
   */
  @IsOptional()
  @IsUUID()
  idempotencyKey?: string;

  /**
   * Delivery details saved in the same transaction as the order — checkout
   * sends them here so it is one operation: an order can't exist without them
   * because a second request failed. Staff placing an order on a customer's
   * behalf can still add them afterwards (`PATCH /orders/:id/delivery-details`).
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaveDeliveryDetailsDto)
  delivery?: SaveDeliveryDetailsDto;
}
