import { RoomType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Language } from '@prisma/client';

export class CreateProfilingQuestionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  text: string;

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  /** Set to make the question conditional — only asked when the customer picked this room type. */
  @IsOptional()
  @IsEnum(RoomType)
  roomType?: RoomType;

  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;

  @IsOptional()
  @IsEnum(Language)
  language?: Language;
}

export class UpdateProfilingQuestionDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  text?: string;

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @IsOptional()
  @IsEnum(RoomType)
  roomType?: RoomType | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ReorderItemDto {
  @IsUUID()
  id: string;

  @IsInt()
  @Min(0)
  position: number;
}

/** Persists the order produced by dragging questions around in the admin panel. */
export class ReorderProfilingQuestionsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ReorderItemDto)
  questions: ReorderItemDto[];
}
