import { Module } from '@nestjs/common';
import { CartNegotiationsController } from './cart-negotiations.controller';
import { CartNegotiationsService } from './cart-negotiations.service';

@Module({
  controllers: [CartNegotiationsController],
  providers: [CartNegotiationsService],
})
export class CartNegotiationsModule {}
