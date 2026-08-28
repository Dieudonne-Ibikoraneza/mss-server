import { IsOptional, IsString, IsUUID } from 'class-validator';

export class AddFavoriteDto {
  @IsUUID()
  productId: string;

  @IsOptional()
  @IsString()
  sessionId?: string;
}
