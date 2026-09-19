import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { PaymentsService } from './payments.service';
import { InitiatePaymentDto } from './dto/initiate-payment.dto';

@ApiTags('payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @ApiOperation({
    summary: 'Initiate an online payment for an order (not available yet — responds 501)',
    description:
      'No payment provider is integrated. Customers pay with the MoMo/bank details on the quotation and confirm through the quotation endpoints (`/orders/:id/quotation/*`).',
  })
  @Post()
  initiate(@Body() dto: InitiatePaymentDto, @CurrentUser() user: AuthenticatedUser) {
    return this.paymentsService.initiate(dto, user);
  }

  @ApiOperation({ summary: 'Get payment(s) for an order' })
  @Get('order/:orderId')
  findForOrder(@Param('orderId') orderId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.paymentsService.findForOrder(orderId, user);
  }
}
