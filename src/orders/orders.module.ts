import { Module } from '@nestjs/common';
import { EventsModule } from '@/events/events.module';
import { NotificationsModule } from '@/notifications/notifications.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [EventsModule, NotificationsModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
