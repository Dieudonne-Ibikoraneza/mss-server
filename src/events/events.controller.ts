import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@/common/decorators/public.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { EventsService } from './events.service';
import { RecordTileEventDto } from './dto/record-tile-event.dto';
import { RecordJourneyEventDto } from './dto/record-journey-event.dto';

/**
 * Public ingestion endpoints so the frontend can log interactions (product
 * viewed, tile applied in the 3D room, journey stage reached) even for
 * anonymous visitors, keyed by a client-generated sessionId.
 */
@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Public()
  @ApiOperation({
    summary: 'Record a tile interaction event',
    description: 'Anonymous-safe; keyed by client-generated sessionId.',
  })
  @Post('tile')
  recordTileEvent(@Body() dto: RecordTileEventDto, @CurrentUser() user?: AuthenticatedUser) {
    return this.eventsService.recordTileEvent({ ...dto, userId: user?.id });
  }

  @Public()
  @ApiOperation({
    summary: 'Record a customer journey stage event',
    description: 'Anonymous-safe; keyed by client-generated sessionId.',
  })
  @Post('journey')
  recordJourneyEvent(@Body() dto: RecordJourneyEventDto, @CurrentUser() user?: AuthenticatedUser) {
    return this.eventsService.recordJourneyEvent({ ...dto, userId: user?.id });
  }
}
