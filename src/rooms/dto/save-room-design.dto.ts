import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class RoomDesignTileInputDto {
  @IsString()
  surface: string;

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
