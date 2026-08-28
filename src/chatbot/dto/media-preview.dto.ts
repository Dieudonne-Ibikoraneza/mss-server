import { ArrayNotEmpty, IsArray, IsOptional, IsString, IsUUID } from 'class-validator';

export class ImagePreviewDto {
  @IsUUID()
  conversationId: string;

  @IsOptional()
  @IsString()
  roomImageUrl?: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsUUID(undefined, { each: true })
  productIds: string[];
}

export class VideoPreviewDto {
  @IsUUID()
  conversationId: string;

  @IsString()
  roomVideoUrl: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsUUID(undefined, { each: true })
  productIds: string[];
}
