-- Soft "Clear chat": the customer's view of a cart negotiation starts after this
-- moment, while the stock team's record stays whole. Null = never cleared, which
-- is the correct value for every existing thread.
ALTER TABLE "CartNegotiation" ADD COLUMN "customerClearedAt" TIMESTAMP(3);
