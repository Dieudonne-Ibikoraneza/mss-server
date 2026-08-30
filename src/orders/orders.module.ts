import { Module } from '@nestjs/common';
import { EventsModule } from '@/events/events.module';
import { NotificationsModule } from '@/notifications/notifications.module';
import { NegotiationsModule } from '@/negotiations/negotiations.module';
import { CartNegotiationsModule } from '@/cart-negotiations/cart-negotiations.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [EventsModule, NotificationsModule, NegotiationsModule, CartNegotiationsModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
