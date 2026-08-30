import { Module } from '@nestjs/common';
import { NegotiationsModule } from '@/negotiations/negotiations.module';
import { CartNegotiationsController } from './cart-negotiations.controller';
import { CartNegotiationsService } from './cart-negotiations.service';

@Module({
  imports: [NegotiationsModule],
  controllers: [CartNegotiationsController],
  providers: [CartNegotiationsService],
  exports: [CartNegotiationsService],
})
export class CartNegotiationsModule {}
