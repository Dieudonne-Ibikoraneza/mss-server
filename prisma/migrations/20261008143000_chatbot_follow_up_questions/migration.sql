CREATE TABLE "ChatbotFollowUp" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "textRw" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChatbotFollowUp_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ChatbotFollowUp_isActive_position_idx" ON "ChatbotFollowUp"("isActive", "position");

-- Preserve the existing English and Kinyarwanda suggestions on deployment.
INSERT INTO "ChatbotFollowUp" ("id", "text", "textRw", "position", "updatedAt") VALUES
('824045b6-fcc5-5d5f-b0c6-22a8c30a80db', 'I need premium large-format slabs for a grand living room.', 'Nkeneye amabuye manini y''icyiciro cyo hejuru ku cyumba kinini cyo kwakiriramo.', 0, CURRENT_TIMESTAMP),
('49d77bb9-d77a-5a44-bdcd-f8873597c869', 'What tiles work best for a bathroom — floor and walls?', 'Ni amakaro ki akwiriye ubwiherero — ku butaka no ku nkuta?', 1, CURRENT_TIMESTAMP),
('1dbb2b84-3d46-56fa-9fa9-f843e67f6253', 'What tiles are best for a modern kitchen?', 'Ni amakaro ki meza ku gikoni cya kijyambere?', 2, CURRENT_TIMESTAMP),
('f0181e3c-f718-5720-9e60-bbde618c0af5', 'Show me the most durable floor tiles.', 'Nyereka amakaro y''ubutaka arambye cyane.', 3, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
