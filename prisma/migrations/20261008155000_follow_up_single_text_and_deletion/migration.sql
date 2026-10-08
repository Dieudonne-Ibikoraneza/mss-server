-- Follow-up suggestions now use a single admin-managed question text.
ALTER TABLE "ChatbotFollowUp" DROP COLUMN "textRw", ADD COLUMN "deletedAt" TIMESTAMP(3);
