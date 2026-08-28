import { TileEventType } from '@prisma/client';
import { IsEnum, IsObject, IsOptional, IsString, IsUUID } from 'class-validator';

export class RecordTileEventDto {
  @IsUUID()
  productId: string;

  @IsEnum(TileEventType)
  type: TileEventType;

  @IsString()
  sessionId: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
