-- Tracks when the customer first opened the in-system PDF quotation; paying
-- can only be marked once this is set.
ALTER TABLE "Order" ADD COLUMN "quotationViewedAt" TIMESTAMP(3);
