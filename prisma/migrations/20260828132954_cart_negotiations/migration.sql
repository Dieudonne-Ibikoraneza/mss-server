-- CreateTable
CREATE TABLE "CartNegotiation" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CartNegotiation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CartNegotiationItem" (
    "id" TEXT NOT NULL,
    "negotiationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "requestedAreaSqm" DECIMAL(10,2) NOT NULL,
    "requestedPieces" INTEGER NOT NULL,
    "availablePieces" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CartNegotiationItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CartNegotiationMessage" (
    "id" TEXT NOT NULL,
    "negotiationId" TEXT NOT NULL,
    "author" "OrderMessageAuthor" NOT NULL,
    "senderId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CartNegotiationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CartNegotiation_customerId_idx" ON "CartNegotiation"("customerId");

-- CreateIndex
CREATE INDEX "CartNegotiationItem_negotiationId_idx" ON "CartNegotiationItem"("negotiationId");

-- CreateIndex
CREATE INDEX "CartNegotiationMessage_negotiationId_idx" ON "CartNegotiationMessage"("negotiationId");

-- AddForeignKey
ALTER TABLE "CartNegotiation" ADD CONSTRAINT "CartNegotiation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartNegotiationItem" ADD CONSTRAINT "CartNegotiationItem_negotiationId_fkey" FOREIGN KEY ("negotiationId") REFERENCES "CartNegotiation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartNegotiationItem" ADD CONSTRAINT "CartNegotiationItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartNegotiationMessage" ADD CONSTRAINT "CartNegotiationMessage_negotiationId_fkey" FOREIGN KEY ("negotiationId") REFERENCES "CartNegotiation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartNegotiationMessage" ADD CONSTRAINT "CartNegotiationMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
