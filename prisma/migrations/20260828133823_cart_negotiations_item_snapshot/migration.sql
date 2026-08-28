/*
  Warnings:

  - You are about to drop the column `availablePieces` on the `CartNegotiationItem` table. All the data in the column will be lost.
  - You are about to drop the column `requestedPieces` on the `CartNegotiationItem` table. All the data in the column will be lost.
  - Added the required column `availabilityNote` to the `CartNegotiationItem` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "CartNegotiationItem" DROP CONSTRAINT "CartNegotiationItem_productId_fkey";

-- AlterTable
ALTER TABLE "CartNegotiationItem" DROP COLUMN "availablePieces",
DROP COLUMN "requestedPieces",
ADD COLUMN     "availabilityNote" TEXT NOT NULL;
