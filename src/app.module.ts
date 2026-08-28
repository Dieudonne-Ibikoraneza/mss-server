import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { EventEmitterModule } from '@nestjs/event-emitter';

import configuration from './config/configuration';
import { validationSchema } from './config/validation.schema';

import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';

import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { CollectionsModule } from './collections/collections.module';
import { ProductsModule } from './products/products.module';
import { CartModule } from './cart/cart.module';
import { OrdersModule } from './orders/orders.module';
import { CartNegotiationsModule } from './cart-negotiations/cart-negotiations.module';
import { PaymentsModule } from './payments/payments.module';
import { FavoritesModule } from './favorites/favorites.module';
import { RoomsModule } from './rooms/rooms.module';
import { ChatbotModule } from './chatbot/chatbot.module';
import { CalculatorModule } from './calculator/calculator.module';
import { QuotesModule } from './quotes/quotes.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { EventsModule } from './events/events.module';
import { ReportsModule } from './reports/reports.module';
import { SettingsModule } from './settings/settings.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], validationSchema }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: config.get<number>('throttle.ttlMs') ?? 60_000,
            limit: config.get<number>('throttle.limit') ?? 100,
          },
        ],
        storage: new ThrottlerStorageRedisService(config.get<string>('redis.url')),
      }),
    }),
    EventEmitterModule.forRoot(),

    PrismaModule,
    RedisModule,

    AuthModule,
    UsersModule,
    CollectionsModule,
    ProductsModule,
    CartModule,
    OrdersModule,
    CartNegotiationsModule,
    PaymentsModule,
    FavoritesModule,
    RoomsModule,
    ChatbotModule,
    CalculatorModule,
    QuotesModule,
    AnalyticsModule,
    EventsModule,
    ReportsModule,
    SettingsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
