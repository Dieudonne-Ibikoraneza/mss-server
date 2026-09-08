import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

/**
 * Doc 3.6's "put this tile on my floor" preview: the customer's own uploaded
 * room photo (already persisted via `POST /chatbot/preview/room-photo`,
 * `roomImagePath` is the bare storage path that returned) edited with one
 * tile they picked from the catalog. Video is out of scope — only images.
 */
export class ImagePreviewDto {
  @IsUUID()
  conversationId: string;

  @IsString()
  @IsNotEmpty()
  roomImagePath: string;

  @IsUUID()
  productId: string;

  /** Customer's own note shown alongside their photo — defaults to a plain description if omitted. */
  @IsOptional()
  @IsString()
  note?: string;
}
