-- Checkout idempotency: one order per (customer, checkout key). Existing orders
-- have no key (NULL), and Postgres treats NULLs as distinct, so they never collide.
ALTER TABLE "Order" ADD COLUMN "clientRequestId" TEXT;
CREATE UNIQUE INDEX "Order_customerId_clientRequestId_key" ON "Order"("customerId", "clientRequestId");
