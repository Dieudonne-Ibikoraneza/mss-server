import { Module } from '@nestjs/common';
import { EventsModule } from '@/events/events.module';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';

@Module({
  imports: [EventsModule],
  controllers: [QuotesController],
  providers: [QuotesService],
})
export class QuotesModule {}
