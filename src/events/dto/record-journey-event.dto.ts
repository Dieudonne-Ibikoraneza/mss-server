import { JourneyStage } from '@prisma/client';
import { IsEnum, IsObject, IsOptional, IsString } from 'class-validator';

export class RecordJourneyEventDto {
  @IsEnum(JourneyStage)
  stage: JourneyStage;

  @IsString()
  sessionId: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
