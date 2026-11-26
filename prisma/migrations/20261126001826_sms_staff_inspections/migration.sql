-- CreateEnum
CREATE TYPE "SmsStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StaffCategory" AS ENUM ('TEACHING', 'NON_TEACHING');

-- CreateEnum
CREATE TYPE "StaffStatus" AS ENUM ('ACTIVE', 'ON_LEAVE', 'LEFT', 'RETIRED');

-- CreateEnum
CREATE TYPE "PostingStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "School" ADD COLUMN     "absenceSms" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "SmsMessage" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "schoolId" UUID,
    "studentId" UUID,
    "parentId" UUID,
    "date" DATE,
    "status" "SmsStatus" NOT NULL DEFAULT 'QUEUED',
    "sendAfter" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT,
    "providerId" TEXT,
    "cost" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "SmsMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Staff" (
    "id" UUID NOT NULL,
    "staffNumber" TEXT NOT NULL,
    "surname" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "middleName" TEXT,
    "sex" "Sex" NOT NULL,
    "dateOfBirth" DATE,
    "phone" TEXT,
    "email" TEXT,
    "category" "StaffCategory" NOT NULL,
    "rank" TEXT,
    "gradeLevel" INTEGER,
    "step" INTEGER,
    "firstAppointment" DATE,
    "trcnNumber" TEXT,
    "subjects" TEXT[],
    "status" "StaffStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentSchoolId" UUID,
    "userId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Qualification" (
    "id" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "course" TEXT,
    "institution" TEXT,
    "year" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Qualification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Posting" (
    "id" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "reason" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Posting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostingRequest" (
    "id" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "fromSchoolId" UUID,
    "toSchoolId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "status" "PostingStatus" NOT NULL DEFAULT 'REQUESTED',
    "note" TEXT,
    "requestedById" UUID NOT NULL,
    "decidedById" UUID,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "PostingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Training" (
    "id" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "provider" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "hours" INTEGER,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Training_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inspection" (
    "id" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "schoolId" UUID NOT NULL,
    "inspectorId" UUID NOT NULL,
    "visitedOn" DATE NOT NULL,
    "template" INTEGER NOT NULL DEFAULT 1,
    "answers" JSONB NOT NULL,
    "overall" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Inspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionPhoto" (
    "id" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "inspectionId" UUID NOT NULL,
    "section" TEXT NOT NULL,
    "caption" TEXT,
    "contentType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "data" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspectionPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SmsMessage_status_sendAfter_idx" ON "SmsMessage"("status", "sendAfter");

-- CreateIndex
CREATE INDEX "SmsMessage_schoolId_createdAt_idx" ON "SmsMessage"("schoolId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SmsMessage_kind_studentId_parentId_date_key" ON "SmsMessage"("kind", "studentId", "parentId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Staff_staffNumber_key" ON "Staff"("staffNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Staff_userId_key" ON "Staff"("userId");

-- CreateIndex
CREATE INDEX "Staff_currentSchoolId_idx" ON "Staff"("currentSchoolId");

-- CreateIndex
CREATE INDEX "Staff_surname_firstName_idx" ON "Staff"("surname", "firstName");

-- CreateIndex
CREATE INDEX "Posting_staffId_startDate_idx" ON "Posting"("staffId", "startDate");

-- CreateIndex
CREATE INDEX "Posting_schoolId_idx" ON "Posting"("schoolId");

-- CreateIndex
CREATE INDEX "PostingRequest_status_idx" ON "PostingRequest"("status");

-- CreateIndex
CREATE INDEX "PostingRequest_staffId_idx" ON "PostingRequest"("staffId");

-- CreateIndex
CREATE INDEX "Training_staffId_idx" ON "Training"("staffId");

-- CreateIndex
CREATE UNIQUE INDEX "Inspection_clientId_key" ON "Inspection"("clientId");

-- CreateIndex
CREATE INDEX "Inspection_schoolId_visitedOn_idx" ON "Inspection"("schoolId", "visitedOn");

-- CreateIndex
CREATE INDEX "Inspection_inspectorId_idx" ON "Inspection"("inspectorId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionPhoto_clientId_key" ON "InspectionPhoto"("clientId");

-- CreateIndex
CREATE INDEX "InspectionPhoto_inspectionId_idx" ON "InspectionPhoto"("inspectionId");

-- AddForeignKey
ALTER TABLE "Staff" ADD CONSTRAINT "Staff_currentSchoolId_fkey" FOREIGN KEY ("currentSchoolId") REFERENCES "School"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Staff" ADD CONSTRAINT "Staff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Qualification" ADD CONSTRAINT "Qualification_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Posting" ADD CONSTRAINT "Posting_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Posting" ADD CONSTRAINT "Posting_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostingRequest" ADD CONSTRAINT "PostingRequest_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Training" ADD CONSTRAINT "Training_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_inspectorId_fkey" FOREIGN KEY ("inspectorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionPhoto" ADD CONSTRAINT "InspectionPhoto_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
