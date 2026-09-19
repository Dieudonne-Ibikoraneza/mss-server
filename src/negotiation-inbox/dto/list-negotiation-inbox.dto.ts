import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Cursor pagination + server-side search for the staff negotiation inbox. */
export class ListNegotiationInboxDto {
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
  limit?: number = 25;

  /** Matches the customer's name or email, or an order number. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
