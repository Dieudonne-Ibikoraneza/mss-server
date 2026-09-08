-- AlterTable
ALTER TABLE "Recommendation" ADD COLUMN     "messageId" TEXT;

-- CreateIndex
CREATE INDEX "Recommendation_messageId_idx" ON "Recommendation"("messageId");

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
