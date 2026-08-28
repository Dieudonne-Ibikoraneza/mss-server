import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateCartNegotiationMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  body: string;
}
