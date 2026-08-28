import { OrderCreatorType, OrderStatus, QuotationStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationDto } from '@/common/dto/pagination.dto';

export class QueryOrdersDto extends PaginationDto {
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @IsOptional()
  @IsEnum(QuotationStatus)
  quotationStatus?: QuotationStatus;

  /** Filters the "created by customer" vs "created by staff" tabs the order lists show. */
  @IsOptional()
  @IsEnum(OrderCreatorType)
  createdByType?: OrderCreatorType;

  @IsOptional()
  @IsUUID()
  customerId?: string;
}
