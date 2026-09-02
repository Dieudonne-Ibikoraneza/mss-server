import { Module } from '@nestjs/common';
import { EventsModule } from '@/events/events.module';
import { ProductsModule } from '@/products/products.module';
import { FavoritesController } from './favorites.controller';
import { FavoritesService } from './favorites.service';

@Module({
  imports: [EventsModule, ProductsModule],
  controllers: [FavoritesController],
  providers: [FavoritesService],
})
export class FavoritesModule {}
