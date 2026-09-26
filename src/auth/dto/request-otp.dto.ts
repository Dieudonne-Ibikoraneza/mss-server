import { Language } from '@prisma/client';
import { IsEmail, IsEnum, IsOptional } from 'class-validator';

export class RequestOtpDto {
  @IsEmail()
  email: string;

  @IsOptional()
  @IsEnum(Language)
  language?: Language;
}
