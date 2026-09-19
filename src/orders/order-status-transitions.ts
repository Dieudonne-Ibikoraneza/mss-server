import { OrderStatus } from '@prisma/client';

/**
 * Where a manual status change may go from each status — one step forward
 * along the fulfilment line, or a cancellation while the goods are still in
 * the warehouse. WAITLISTED never advances by hand (`promoteWaitlistedOrders`
 * does that); SHIPPED can't be cancelled (the tiles have left, so putting
 * them back into on-hand would be wrong); DELIVERED and CANCELLED are final.
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  [OrderStatus.WAITLISTED]: [OrderStatus.CANCELLED],
  [OrderStatus.PENDING]: [OrderStatus.PROCESSING, OrderStatus.CANCELLED],
  [OrderStatus.PROCESSING]: [OrderStatus.READY_FOR_DISPATCH, OrderStatus.CANCELLED],
  [OrderStatus.READY_FOR_DISPATCH]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.CANCELLED]: [],
};

export const canTransitionOrderStatus = (from: OrderStatus, to: OrderStatus): boolean =>
  ORDER_STATUS_TRANSITIONS[from].includes(to);
