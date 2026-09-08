import { Module } from '@nestjs/common';
import { StorageModule } from '@/storage/storage.module';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';

@Module({
  imports: [StorageModule],
  controllers: [CartController],
  providers: [CartService],
})
export class CartModule {}
