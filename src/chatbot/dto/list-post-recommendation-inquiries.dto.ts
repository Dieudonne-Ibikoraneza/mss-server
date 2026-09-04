import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Cursor pagination for the admin/marketing "questions customers ask after
 * seeing recommendations" feed — built for infinite scroll: new rows keep
 * arriving while an admin scrolls, so an offset (skip/take) would silently
 * skip or repeat rows. A cursor on the last-seen row's id doesn't have that
 * problem. */
export class ListPostRecommendationInquiriesDto {
  /** The `id` of the last row already loaded — omit for the first page. */
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
