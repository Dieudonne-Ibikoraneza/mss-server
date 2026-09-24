import { OrderCreatorType, OrderStatus, QuotationStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
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

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @IsOptional()
  @IsDateString()
  createdTo?: string;

  @IsOptional()
  @IsEnum(['newest', 'oldest', 'amount_high', 'amount_low'])
  sort?: 'newest' | 'oldest' | 'amount_high' | 'amount_low' = 'newest';
}
