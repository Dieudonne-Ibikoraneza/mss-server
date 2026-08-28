import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Where and when to deliver an order. Mirrors the customer-facing delivery
 * details form: contact, phone, address and city are required, the preferred
 * date is free text ("within 3 days of confirmation") and notes are optional.
 */
export class SaveDeliveryDetailsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  contactName: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  phone: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  address: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  city: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  preferredDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
