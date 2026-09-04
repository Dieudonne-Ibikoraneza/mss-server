import { Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '@/common/decorators/roles.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import { SaveDeliveryDetailsDto } from './dto/save-delivery-details.dto';
import { SendQuotationDto } from './dto/send-quotation.dto';
import { CreateOrderMessageDto } from './dto/create-order-message.dto';
import { UpdateOrderItemsDto } from './dto/update-order-items.dto';

@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @ApiOperation({ summary: 'Create an order' })
  @Post()
  create(@Body() dto: CreateOrderDto, @CurrentUser() user: AuthenticatedUser) {
    return this.ordersService.create(dto, user);
  }

  @ApiOperation({
    summary: 'List orders',
    description: 'Clients see their own; staff can see all.',
  })
  @Get()
  findAll(@Query() query: QueryOrdersDto, @CurrentUser() user: AuthenticatedUser) {
    return this.ordersService.findAll(query, user);
  }

  @ApiOperation({ summary: 'Get an order by id' })
  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.ordersService.findOne(id, user);
  }

  @Roles(Role.ADMIN, Role.STOCK_MANAGER, Role.SALES_PERSON)
  @ApiOperation({ summary: 'Update order status (admin/stock/sales)' })
  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ordersService.updateStatus(id, dto, user);
  }

  @Roles(Role.ADMIN, Role.STOCK_MANAGER)
  @ApiOperation({ summary: 'Edit order quantities (admin/stock)' })
  @Patch(':id/items')
  updateItems(
    @Param('id') id: string,
    @Body() dto: UpdateOrderItemsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ordersService.updateItems(id, dto, user);
  }

  @ApiOperation({
    summary: 'Save the delivery details for an order',
    description: 'The customer who owns the order, or any staff member on their behalf.',
  })
  @Patch(':id/delivery-details')
  saveDeliveryDetails(
    @Param('id') id: string,
    @Body() dto: SaveDeliveryDetailsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ordersService.saveDeliveryDetails(id, dto, user);
  }

  @Roles(Role.ADMIN, Role.STOCK_MANAGER)
  @ApiOperation({
    summary: 'Set the transport fee and send the quotation (admin/stock)',
    description: 'A transport fee of 0 is valid and means free delivery.',
  })
  @Post(':id/quotation')
  sendQuotation(
    @Param('id') id: string,
    @Body() dto: SendQuotationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ordersService.sendQuotation(id, dto, user);
  }

  @ApiOperation({
    summary: 'View the quotation as a PDF, in-system',
    description:
      "Never emailed — this call is the only way to see it. The customer's own first view " +
      'unlocks "mark payment submitted" below.',
  })
  @Get(':id/quotation')
  async viewQuotation(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ) {
    const pdf = await this.ordersService.viewQuotation(id, user);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="quotation-${id}.pdf"`);
    res.setHeader('Content-Length', pdf.length);
    res.send(pdf);
  }

  @ApiOperation({ summary: 'Mark the quotation as paid (customer)' })
  @Post(':id/quotation/payment-submitted')
  markPaymentSubmitted(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.ordersService.markPaymentSubmitted(id, user);
  }

  @Roles(Role.ADMIN, Role.STOCK_MANAGER)
  @ApiOperation({ summary: 'Verify a submitted payment (admin/stock)' })
  @Post(':id/quotation/verify')
  verifyPayment(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.ordersService.verifyPayment(id, user);
  }

  @ApiOperation({
    summary: 'Read the negotiation thread on an order',
    description:
      'Opened automatically with a SYSTEM message when an order exceeds the stock on hand.',
  })
  @Get(':id/messages')
  listMessages(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.ordersService.listMessages(id, user);
  }

  @ApiOperation({ summary: 'Post a message to an order negotiation thread' })
  @Post(':id/messages')
  postMessage(
    @Param('id') id: string,
    @Body() dto: CreateOrderMessageDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ordersService.postMessage(id, dto, user);
  }
}
