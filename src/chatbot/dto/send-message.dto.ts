import { Language } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Allows a complete preference brief; the composer still caps individual answers at 2,000. */
const MAX_CONTENT_LENGTH = 32_768;

export class SendMessageDto {
  @IsString()
  sessionId: string;

  @IsOptional()
  @IsString()
  conversationId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_CONTENT_LENGTH)
  content: string;

  @IsOptional()
  @IsEnum(Language)
  language?: Language = Language.EN;
}
