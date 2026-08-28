import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateOrderMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  body: string;
}
