-- AlterTable
ALTER TABLE "KnowledgeBaseEntry" ADD COLUMN     "translatedFromId" TEXT;

-- AddForeignKey
ALTER TABLE "KnowledgeBaseEntry" ADD CONSTRAINT "KnowledgeBaseEntry_translatedFromId_fkey" FOREIGN KEY ("translatedFromId") REFERENCES "KnowledgeBaseEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
