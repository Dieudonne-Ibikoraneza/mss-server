import { TileEventType } from '@prisma/client';
import { IsEnum, IsObject, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

export class RecordTileEventDto {
  @IsUUID()
  productId: string;

  @IsEnum(TileEventType)
  type: TileEventType;

  @IsString()
  @Length(1, 128)
  @Matches(/^[A-Za-z0-9._:-]+$/, {
    message: 'sessionId may contain only letters, numbers, dots, underscores, colons, and hyphens.',
  })
  sessionId: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
