import { Language } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Matches the frontend's own input cap — also bounds AI provider cost/latency per message. */
const MAX_CONTENT_LENGTH = 2000;

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
