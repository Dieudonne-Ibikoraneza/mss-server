import { Language } from '@prisma/client';
import { IsArray, IsBoolean, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';

export class UpsertKnowledgeBaseEntryDto {
  @IsString()
  @MinLength(3)
  question: string;

  @IsString()
  @MinLength(1)
  answer: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsEnum(Language)
  language?: Language = Language.EN;
}

export class UpdateKnowledgeBaseEntryDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  question?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  answer?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsEnum(Language)
  language?: Language;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
