import { RoomType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateRoomDto {
  @IsEnum(RoomType)
  type: RoomType;

  @IsString()
  @MinLength(2)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  modelUrl: string;

  @IsOptional()
  @IsString()
  thumbnail?: string;
}
