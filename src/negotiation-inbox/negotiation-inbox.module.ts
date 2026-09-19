import { Module } from '@nestjs/common';
import { NegotiationInboxController } from './negotiation-inbox.controller';
import { NegotiationInboxService } from './negotiation-inbox.service';

@Module({
  controllers: [NegotiationInboxController],
  providers: [NegotiationInboxService],
})
export class NegotiationInboxModule {}
