import { IsIn, IsObject, IsString } from 'class-validator';

export class PaymentWebhookDto {
  @IsString()
  providerRef: string;

  @IsIn(['SUCCEEDED', 'FAILED'])
  status: 'SUCCEEDED' | 'FAILED';

  @IsObject()
  raw: Record<string, unknown>;
}
