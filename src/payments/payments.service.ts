import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentMethod, PaymentStatus, Prisma, Role } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { MomoProvider } from './providers/momo.provider';
import { CardProvider } from './providers/card.provider';
import { InitiatePaymentDto } from './dto/initiate-payment.dto';
import { PaymentWebhookDto } from './dto/payment-webhook.dto';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly momo: MomoProvider,
    private readonly card: CardProvider,
  ) {}

  async initiate(dto: InitiatePaymentDto, actingUser: AuthenticatedUser) {
    const order = await this.prisma.order.findUnique({ where: { id: dto.orderId } });
    if (!order) throw new NotFoundException('Order not found.');

    const staffRoles: Role[] = [Role.ADMIN, Role.SALES_PERSON, Role.STOCK_MANAGER];
    const isStaff = staffRoles.includes(actingUser.role);
    if (!isStaff && order.customerId !== actingUser.id) {
      throw new ForbiddenException('You do not have access to this order.');
    }

    const provider = dto.method === PaymentMethod.MOMO ? this.momo : this.card;
    const result = await provider.initiate({
      orderId: order.id,
      amount: Number(order.total),
      currency: order.currency,
      phone: dto.phone,
      cardToken: dto.cardToken,
    });

    return this.prisma.payment.create({
      data: {
        orderId: order.id,
        method: dto.method,
        status: result.status === 'SUCCEEDED' ? PaymentStatus.SUCCEEDED : PaymentStatus.PENDING,
        amount: order.total,
        currency: order.currency,
        providerRef: result.providerRef,
      },
    });
  }

  /** Called by the provider's webhook once a MoMo/card payment settles. */
  async handleWebhook(dto: PaymentWebhookDto) {
    const payment = await this.prisma.payment.findFirst({
      where: { providerRef: dto.providerRef },
    });
    if (!payment) throw new BadRequestException('Unknown payment reference.');

    return this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: dto.status === 'SUCCEEDED' ? PaymentStatus.SUCCEEDED : PaymentStatus.FAILED,
        rawPayload: dto.raw as Prisma.InputJsonValue,
      },
    });
  }

  findForOrder(orderId: string) {
    return this.prisma.payment.findMany({ where: { orderId }, orderBy: { createdAt: 'desc' } });
  }
}
