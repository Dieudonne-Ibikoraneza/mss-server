import { IsOptional, IsString } from 'class-validator';

export class UpdateRoomDto {
  /** Room templates are fixed; administrators can only replace their thumbnail. */
  @IsOptional()
  @IsString()
  thumbnail?: string;
}
