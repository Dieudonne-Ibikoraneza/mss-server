import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, PaymentMethod, PaymentStatus, QuotationStatus, Role } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import type { AuthenticatedUser } from '@/auth/types/authenticated-user.type';
import { MomoProvider } from './providers/momo.provider';
import { CardProvider } from './providers/card.provider';
import { InitiatePaymentDto } from './dto/initiate-payment.dto';

@Injectable()
export class PaymentsService {
  private readonly operationalStaffRoles: Role[] = [
    Role.ADMIN,
    Role.SALES_PERSON,
    Role.STOCK_MANAGER,
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly momo: MomoProvider,
    private readonly card: CardProvider,
  ) {}

  /** Customers may access only their own orders; operational staff may access any order. */
  private async assertOrderAccess(orderId: string, actingUser: AuthenticatedUser) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found.');

    const isOperationalStaff = this.operationalStaffRoles.includes(actingUser.role);
    if (!isOperationalStaff && order.customerId !== actingUser.id) {
      throw new ForbiddenException('You do not have access to this order.');
    }

    return order;
  }

  /**
   * A payment is only meaningful once a quotation has gone out — before that
   * `order.total` is just the subtotal (no transport fee yet), and cancelled
   * orders never accept payment even if a quotation was sent before cancellation.
   */
  private assertPaymentReady(order: { status: OrderStatus; quotationStatus: QuotationStatus }) {
    if (order.status === OrderStatus.CANCELLED) {
      throw new BadRequestException('This order has been cancelled and cannot accept payment.');
    }
    if (order.quotationStatus !== QuotationStatus.QUOTATION_SENT) {
      throw new BadRequestException(
        'A payment can only be initiated once a quotation has been sent for this order and is still awaiting payment.',
      );
    }
  }

  async initiate(dto: InitiatePaymentDto, actingUser: AuthenticatedUser) {
    const order = await this.assertOrderAccess(dto.orderId, actingUser);
    this.assertPaymentReady(order);

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

  async findForOrder(orderId: string, actingUser: AuthenticatedUser) {
    await this.assertOrderAccess(orderId, actingUser);
    return this.prisma.payment.findMany({ where: { orderId }, orderBy: { createdAt: 'desc' } });
  }
}
