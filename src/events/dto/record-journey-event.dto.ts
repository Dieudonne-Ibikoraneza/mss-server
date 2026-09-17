import { JourneyStage } from '@prisma/client';
import { IsEnum, IsObject, IsOptional, IsString, Length, Matches } from 'class-validator';

export class RecordJourneyEventDto {
  @IsEnum(JourneyStage)
  stage: JourneyStage;

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
