import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { NegotiationsGateway } from './negotiations.gateway';

/**
 * Standalone module so `OrdersModule` and `CartNegotiationsModule` can both
 * pull in the same gateway instance without depending on each other — Nest
 * keeps a single instance per app regardless of how many modules import it.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.accessSecret'),
      }),
    }),
  ],
  providers: [NegotiationsGateway],
  exports: [NegotiationsGateway],
})
export class NegotiationsModule {}
