-- AlterTable
ALTER TABLE "ChatConversation" ADD COLUMN     "title" TEXT;

-- CreateTable
CREATE TABLE "PostRecommendationInquiry" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT,
    "messageId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostRecommendationInquiry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PostRecommendationInquiry_conversationId_idx" ON "PostRecommendationInquiry"("conversationId");

-- CreateIndex
CREATE INDEX "PostRecommendationInquiry_userId_idx" ON "PostRecommendationInquiry"("userId");

-- CreateIndex
CREATE INDEX "PostRecommendationInquiry_createdAt_idx" ON "PostRecommendationInquiry"("createdAt");

-- AddForeignKey
ALTER TABLE "PostRecommendationInquiry" ADD CONSTRAINT "PostRecommendationInquiry_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostRecommendationInquiry" ADD CONSTRAINT "PostRecommendationInquiry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
