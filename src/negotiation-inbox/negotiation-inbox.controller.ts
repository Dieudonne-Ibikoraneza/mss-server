import { Controller, Get, Param, ParseEnumPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '@/common/decorators/roles.decorator';
import { ListNegotiationInboxDto } from './dto/list-negotiation-inbox.dto';
import { NegotiationInboxService } from './negotiation-inbox.service';

/** Route param for the two kinds of negotiation thread. */
enum ThreadKindParam {
  order = 'order',
  cart = 'cart',
}

/**
 * The staff negotiation inbox — stock managers and admins only. The data
 * analyst has no access to negotiations at all (403), like every other
 * negotiation route.
 */
@ApiTags('negotiations')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.STOCK_MANAGER)
@Controller('negotiations/inbox')
export class NegotiationInboxController {
  constructor(private readonly inbox: NegotiationInboxService) {}

  @ApiOperation({
    summary: 'Negotiation inbox: every order and cart thread, newest activity first',
    description:
      'One paginated call instead of one request per thread. Each row carries the customer, the ' +
      'thread kind/id (fetch the full conversation from `GET /orders/:id/messages` or ' +
      '`GET /cart-negotiations/:id`), its message count and its latest message. Cursor-paginated: ' +
      'pass `nextCursor` back as `cursor`. `search` matches the customer name/email or an order number.',
  })
  @Get()
  list(@Query() query: ListNegotiationInboxDto) {
    return this.inbox.list(query);
  }

  @ApiOperation({
    summary: "One thread's inbox row (used to refresh a single line after a live update)",
  })
  @Get(':kind/:id')
  summary(
    @Param('kind', new ParseEnumPipe(ThreadKindParam)) kind: ThreadKindParam,
    @Param('id') id: string,
  ) {
    return this.inbox.summary(kind, id);
  }
}
