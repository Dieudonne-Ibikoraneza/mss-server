-- CreateTable
CREATE TABLE "KeyValueEntry" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "KeyValueEntry_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "KeyValueEntry_expiresAt_idx" ON "KeyValueEntry"("expiresAt");
