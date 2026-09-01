import { Role, UserStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '@/common/dto/pagination.dto';

export class QueryStaffDto extends PaginationDto {
  /** Narrows to one staff role; omitted, every staff role is returned. */
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  /** Matches against name, email or phone. */
  @IsOptional()
  @IsString()
  search?: string;
}

export class QueryCustomersDto extends PaginationDto {
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @IsOptional()
  @IsString()
  search?: string;

  /** Default `newest` (createdAt desc, cheap). `spend` ranks by lifetime spend — needed for a real "Top Customers" list instead of over-fetching and sorting client-side. */
  @IsOptional()
  @IsEnum(['newest', 'spend'])
  sort?: 'newest' | 'spend';
}
