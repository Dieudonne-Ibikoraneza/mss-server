import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/** Why a submitted payment could not be confirmed — shown to the customer, so it is required. */
export class RejectPaymentDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'reason must not be blank' })
  @MaxLength(500)
  reason: string;
}
