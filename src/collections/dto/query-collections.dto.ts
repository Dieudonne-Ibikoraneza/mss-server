import { PaginationDto } from '@/common/dto/pagination.dto';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export enum CollectionSort {
  NEWEST = 'newest',
  OLDEST = 'oldest',
}

export class QueryCollectionsDto extends PaginationDto {
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
