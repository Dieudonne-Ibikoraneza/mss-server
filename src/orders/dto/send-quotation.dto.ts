import { IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * Stock-team step of the quotation workflow: attach the transport fee agreed
 * with the customer and send the quotation. A fee of 0 is valid and means free
 * transport — that is why the field is required rather than optional.
 */
export class SendQuotationDto {
  @IsNumber()
  @Min(0)
  transportFee: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  transportFeeNote?: string;
}
