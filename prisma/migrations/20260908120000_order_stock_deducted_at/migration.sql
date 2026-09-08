-- Records when an order's items were physically removed from Product.quantityOnHandSqm.
-- Stock now leaves on-hand at payment verification (verifyPayment) rather than at
-- delivery; this column makes that single-shot and lets a later cancellation restock.
ALTER TABLE "Order" ADD COLUMN "stockDeductedAt" TIMESTAMP(3);
