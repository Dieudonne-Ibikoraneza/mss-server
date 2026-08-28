import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { MomoProvider } from './providers/momo.provider';
import { CardProvider } from './providers/card.provider';

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, MomoProvider, CardProvider],
})
export class PaymentsModule {}
