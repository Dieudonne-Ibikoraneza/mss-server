import { RoomSurface } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class RoomDesignTileInputDto {
  /** Which physical surface this product was placed on — FLOOR or WALL, never BOTH (that's a product's own eligibility, not a placement). */
  @IsEnum(RoomSurface)
  surface: RoomSurface;

  @IsUUID()
  productId: string;
}

export class SaveRoomDesignDto {
  @IsUUID()
  roomId: string;

  @IsString()
  @MinLength(1)
  name: string;

  @IsOptional()
  @IsString()
  previewImageUrl?: string;

  @IsOptional()
  @IsBoolean()
  sharedWithSales?: boolean;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => RoomDesignTileInputDto)
  tiles: RoomDesignTileInputDto[];
}
