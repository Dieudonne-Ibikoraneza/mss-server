import { Role } from '@prisma/client';
import { IsEmail, IsIn, IsPhoneNumber, IsString, MinLength } from 'class-validator';

const STAFF_ROLES = [Role.SALES_PERSON, Role.STOCK_MANAGER, Role.DATA_ANALYST, Role.ADMIN];

export class CreateStaffDto {
  @IsString()
  @MinLength(2)
  fullName: string;

  @IsEmail()
  email: string;

  @IsPhoneNumber()
  phone: string;

  @IsIn(STAFF_ROLES)
  role: Role;
}
