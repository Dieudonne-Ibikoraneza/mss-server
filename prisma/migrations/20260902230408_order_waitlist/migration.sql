-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'WAITLISTED';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "waitlistPromotedAt" TIMESTAMP(3);
