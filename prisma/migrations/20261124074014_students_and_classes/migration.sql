-- CreateEnum
CREATE TYPE "ClassLevel" AS ENUM ('PRIMARY_1', 'PRIMARY_2', 'PRIMARY_3', 'PRIMARY_4', 'PRIMARY_5', 'PRIMARY_6', 'JSS_1', 'JSS_2', 'JSS_3', 'SSS_1', 'SSS_2', 'SSS_3');

-- CreateEnum
CREATE TYPE "Sex" AS ENUM ('F', 'M');

-- CreateEnum
CREATE TYPE "StudentStatus" AS ENUM ('ACTIVE', 'WITHDRAWN', 'GRADUATED');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "AcademicSession" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademicSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassArm" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "level" "ClassLevel" NOT NULL,
    "arm" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 40,
    "classTeacherId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassArm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Student" (
    "id" UUID NOT NULL,
    "learnerId" TEXT NOT NULL,
    "surname" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "middleName" TEXT,
    "sex" "Sex" NOT NULL,
    "dateOfBirth" DATE NOT NULL,
    "stateOfOrigin" TEXT,
    "lgaOfOrigin" TEXT,
    "homeAddress" TEXT,
    "status" "StudentStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentSchoolId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Enrolment" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "admissionNumber" TEXT NOT NULL,
    "admittedOn" DATE NOT NULL,
    "leftOn" DATE,
    "leftReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Enrolment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassPlacement" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "classArmId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassPlacement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentGuardian" (
    "studentId" UUID NOT NULL,
    "parentId" UUID NOT NULL,
    "relationship" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentGuardian_pkey" PRIMARY KEY ("studentId","parentId")
);

-- CreateTable
CREATE TABLE "Transfer" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "fromSchoolId" UUID NOT NULL,
    "toSchoolId" UUID NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "requestedById" UUID NOT NULL,
    "decidedById" UUID,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Counter" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Counter_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "AcademicSession_name_key" ON "AcademicSession"("name");

-- CreateIndex
CREATE INDEX "ClassArm_classTeacherId_idx" ON "ClassArm"("classTeacherId");

-- CreateIndex
CREATE UNIQUE INDEX "ClassArm_schoolId_sessionId_level_arm_key" ON "ClassArm"("schoolId", "sessionId", "level", "arm");

-- CreateIndex
CREATE UNIQUE INDEX "Student_learnerId_key" ON "Student"("learnerId");

-- CreateIndex
CREATE INDEX "Student_currentSchoolId_idx" ON "Student"("currentSchoolId");

-- CreateIndex
CREATE INDEX "Student_surname_firstName_dateOfBirth_idx" ON "Student"("surname", "firstName", "dateOfBirth");

-- CreateIndex
CREATE INDEX "Enrolment_studentId_idx" ON "Enrolment"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "Enrolment_schoolId_admissionNumber_key" ON "Enrolment"("schoolId", "admissionNumber");

-- CreateIndex
CREATE INDEX "ClassPlacement_classArmId_idx" ON "ClassPlacement"("classArmId");

-- CreateIndex
CREATE UNIQUE INDEX "ClassPlacement_studentId_sessionId_key" ON "ClassPlacement"("studentId", "sessionId");

-- CreateIndex
CREATE INDEX "StudentGuardian_parentId_idx" ON "StudentGuardian"("parentId");

-- CreateIndex
CREATE INDEX "Transfer_fromSchoolId_status_idx" ON "Transfer"("fromSchoolId", "status");

-- CreateIndex
CREATE INDEX "Transfer_toSchoolId_status_idx" ON "Transfer"("toSchoolId", "status");

-- CreateIndex
CREATE INDEX "Transfer_studentId_idx" ON "Transfer"("studentId");

-- AddForeignKey
ALTER TABLE "ClassArm" ADD CONSTRAINT "ClassArm_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassArm" ADD CONSTRAINT "ClassArm_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AcademicSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassArm" ADD CONSTRAINT "ClassArm_classTeacherId_fkey" FOREIGN KEY ("classTeacherId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_currentSchoolId_fkey" FOREIGN KEY ("currentSchoolId") REFERENCES "School"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrolment" ADD CONSTRAINT "Enrolment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrolment" ADD CONSTRAINT "Enrolment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassPlacement" ADD CONSTRAINT "ClassPlacement_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassPlacement" ADD CONSTRAINT "ClassPlacement_classArmId_fkey" FOREIGN KEY ("classArmId") REFERENCES "ClassArm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassPlacement" ADD CONSTRAINT "ClassPlacement_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AcademicSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentGuardian" ADD CONSTRAINT "StudentGuardian_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentGuardian" ADD CONSTRAINT "StudentGuardian_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_fromSchoolId_fkey" FOREIGN KEY ("fromSchoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_toSchoolId_fkey" FOREIGN KEY ("toSchoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one open enrolment per student, and at most one current session.
CREATE UNIQUE INDEX "Enrolment_one_open_per_student" ON "Enrolment"("studentId") WHERE "leftOn" IS NULL;
CREATE UNIQUE INDEX "AcademicSession_one_current" ON "AcademicSession"("isCurrent") WHERE "isCurrent";
