import { Language } from '@prisma/client';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

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
  @IsIn([Language.EN])
  language?: 'EN' = Language.EN;
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
  @IsIn([Language.EN])
  language?: 'EN';

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
