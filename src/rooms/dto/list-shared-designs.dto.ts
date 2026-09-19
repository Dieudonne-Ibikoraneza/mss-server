import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Cursor pagination + server-side search for the staff "shared designs"
 * review screen. Every design carries its tiles, products and owner, so the
 * page size is deliberately small and the list is never returned in one go.
 */
export class ListSharedDesignsDto {
  /** `nextCursor` from the previous page — omit for the first page. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 12;

  /** Matches the design name, the room name, or the customer's name / email. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
