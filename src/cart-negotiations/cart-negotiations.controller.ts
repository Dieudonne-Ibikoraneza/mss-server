import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '@/common/decorators/roles.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { PaginationDto } from '@/common/dto/pagination.dto';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { CartNegotiationsService } from './cart-negotiations.service';
import { CreateCartNegotiationDto } from './dto/create-cart-negotiation.dto';
import { CreateCartNegotiationMessageDto } from './dto/create-cart-negotiation-message.dto';

@ApiTags('cart-negotiations')
@ApiBearerAuth()
@Controller('cart-negotiations')
export class CartNegotiationsController {
  constructor(private readonly service: CartNegotiationsService) {}

  @ApiOperation({
    summary: "Open (or continue) the customer's pre-order stock negotiation",
    description:
      "For a cart that can't be placed as an order because it exceeds stock on hand. Visible only to the customer and staff.",
  })
  @Post()
  submit(@Body() dto: CreateCartNegotiationDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.submit(dto, user);
  }

  @ApiOperation({ summary: "The calling customer's own negotiation thread, if any" })
  @Get('mine')
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.service.mine(user);
  }

  @ApiOperation({
    summary: "Clear the calling customer's own negotiation thread",
    description: 'Deletes it entirely, including its items and messages — a fresh start, not an archive.',
  })
  @Delete('mine')
  clearMine(@CurrentUser() user: AuthenticatedUser) {
    return this.service.clearMine(user);
  }

  @Roles(Role.ADMIN, Role.STOCK_MANAGER, Role.DATA_ANALYST)
  @ApiOperation({ summary: 'List every customer negotiation thread (stock/admin)' })
  @Get()
  findAll(@Query() query: PaginationDto) {
    return this.service.findAllForStaff(query);
  }

  @ApiOperation({ summary: 'Read one negotiation thread (its customer, or staff)' })
  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.findOne(id, user);
  }

  @ApiOperation({ summary: 'Post a message to a negotiation thread' })
  @Post(':id/messages')
  postMessage(
    @Param('id') id: string,
    @Body() dto: CreateCartNegotiationMessageDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.postMessage(id, dto, user);
  }
}
