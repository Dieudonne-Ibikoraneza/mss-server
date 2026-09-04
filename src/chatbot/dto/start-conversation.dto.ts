import { Language } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

/** Starts a fresh "project" — a brand-new conversation thread, separate from any
 * the customer already has, so they can bring the assistant a new room/spec
 * without losing the history of a previous one. */
export class StartConversationDto {
  @IsOptional()
  @IsEnum(Language)
  language?: Language = Language.EN;
}
