import { RoomType, SuitableFor } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaginationDto } from '@/common/dto/pagination.dto';

/** Matches the catalog's sort control: newest arrivals, price low→high, price high→low. */
export enum ProductSort {
  NEWEST = 'newest',
  PRICE_ASC = 'price_asc',
  PRICE_DESC = 'price_desc',
}

export class QueryProductsDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  collectionId?: string;

  @IsOptional()
  @IsEnum(RoomType)
  roomType?: RoomType;

  /** Filters by the tile size of the product's collection, e.g. "25×40cm". */
  @IsOptional()
  @IsString()
  size?: string;

  @IsOptional()
  @IsEnum(SuitableFor)
  suitableFor?: SuitableFor;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(ProductSort)
  sort?: ProductSort = ProductSort.NEWEST;
}
