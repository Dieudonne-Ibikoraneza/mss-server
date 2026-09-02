import { Module } from '@nestjs/common';
import { EventsModule } from '@/events/events.module';
import { ProductsModule } from '@/products/products.module';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';

@Module({
  imports: [EventsModule, ProductsModule],
  controllers: [RoomsController],
  providers: [RoomsService],
})
export class RoomsModule {}
