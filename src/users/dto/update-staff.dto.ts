import { Role } from '@prisma/client';
import { IsIn, IsOptional, IsPhoneNumber, IsString, MinLength } from 'class-validator';

const STAFF_ROLES = [Role.SALES_PERSON, Role.STOCK_MANAGER, Role.DATA_ANALYST, Role.ADMIN];

/** Everything but email is editable — changing email would desync it from the OTP login flow. */
export class UpdateStaffDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  fullName?: string;

  @IsOptional()
  @IsPhoneNumber()
  phone?: string;

  @IsOptional()
  @IsIn(STAFF_ROLES)
  role?: Role;
}
