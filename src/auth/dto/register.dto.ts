import { HearAboutUs, Language } from '@prisma/client';
import { IsEmail, IsEnum, IsOptional, IsPhoneNumber, IsString, MinLength } from 'class-validator';

export class RegisterDto {
  @IsString()
  @MinLength(2)
  fullName: string;

  @IsEmail()
  email: string;

  @IsPhoneNumber()
  phone: string;

  @IsEnum(HearAboutUs)
  heardAboutUs: HearAboutUs;

  @IsOptional()
  @IsEnum(Language)
  language?: Language = Language.EN;
}
