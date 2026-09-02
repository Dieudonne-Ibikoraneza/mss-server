import { Module } from '@nestjs/common';
import { NotificationsModule } from '@/notifications/notifications.module';
import { StorageModule } from '@/storage/storage.module';
import { OrdersModule } from '@/orders/orders.module';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [NotificationsModule, StorageModule, OrdersModule],
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
