-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('APPLIED', 'REJECTED');

-- CreateTable
CREATE TABLE "SyncEvent" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "SyncStatus" NOT NULL,
    "httpStatus" INTEGER NOT NULL,
    "result" JSONB,

    CONSTRAINT "SyncEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SyncEvent_userId_receivedAt_idx" ON "SyncEvent"("userId", "receivedAt");
