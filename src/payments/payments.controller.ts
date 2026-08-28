import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@/common/decorators/public.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { PaymentsService } from './payments.service';
import { InitiatePaymentDto } from './dto/initiate-payment.dto';
import { PaymentWebhookDto } from './dto/payment-webhook.dto';

@ApiTags('payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @ApiOperation({ summary: 'Initiate a payment (MoMo or card) for an order' })
  @Post()
  initiate(@Body() dto: InitiatePaymentDto, @CurrentUser() user: AuthenticatedUser) {
    return this.paymentsService.initiate(dto, user);
  }

  @ApiOperation({ summary: 'Get payment(s) for an order' })
  @Get('order/:orderId')
  findForOrder(@Param('orderId') orderId: string) {
    return this.paymentsService.findForOrder(orderId);
  }

  @Public()
  @ApiOperation({
    summary: 'Payment provider webhook',
    description: 'Called by MoMo/card providers, not authenticated with a bearer token.',
  })
  @Post('webhook')
  handleWebhook(@Body() dto: PaymentWebhookDto) {
    return this.paymentsService.handleWebhook(dto);
  }
}
