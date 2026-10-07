import { PaginationDto } from '@/common/dto/pagination.dto';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export enum CollectionSort {
  NEWEST = 'newest',
  OLDEST = 'oldest',
}

export enum CollectionCatalogStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ALL = 'all',
}

export class QueryCollectionsDto extends PaginationDto {
  /** Inactive collections are visible only to admins and stock managers. */
  @IsOptional()
  @IsEnum(CollectionCatalogStatus)
  catalogStatus?: CollectionCatalogStatus = CollectionCatalogStatus.ACTIVE;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  size?: string;

  @IsOptional()
  @IsEnum(CollectionSort)
  sort?: CollectionSort = CollectionSort.NEWEST;
}
