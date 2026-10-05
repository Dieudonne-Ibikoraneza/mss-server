UPDATE "Product"
SET "recommendationExcluded" = true, "updatedAt" = CURRENT_TIMESTAMP
WHERE "isActive" = false AND "recommendationExcluded" = false;
