import { Module } from '@nestjs/common';
import { EventsModule } from '@/events/events.module';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';

@Module({
  imports: [EventsModule],
  controllers: [RoomsController],
  providers: [RoomsService],
})
export class RoomsModule {}
