-- CreateEnum
CREATE TYPE "StaffAttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'ABSENT', 'LEAVE');

-- AlterTable
ALTER TABLE "Enrolment" ADD COLUMN     "entryLevel" "ClassLevel";

-- AlterTable
ALTER TABLE "Inspection" ADD COLUMN     "followUp" TEXT,
ADD COLUMN     "followUpAt" TIMESTAMP(3),
ADD COLUMN     "followUpById" UUID,
ADD COLUMN     "followUpNote" TEXT;

-- AlterTable
ALTER TABLE "Notice" ADD COLUMN     "audience" TEXT NOT NULL DEFAULT 'PARENTS';

-- AlterTable
ALTER TABLE "School" ADD COLUMN     "classrooms" INTEGER,
ADD COLUMN     "expectedEnrolment" INTEGER,
ADD COLUMN     "facilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION,
ADD COLUMN     "town" TEXT,
ADD COLUMN     "yearEstablished" INTEGER;

-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "previousSchool" TEXT;

-- AlterTable
ALTER TABLE "Term" ADD COLUMN     "resultsDueOn" DATE,
ADD COLUMN     "scoresClosedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ExamPaper" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "level" "ClassLevel" NOT NULL,
    "subjectCode" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startTime" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamPaper_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PopulationEstimate" (
    "id" UUID NOT NULL,
    "lga" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "stage" TEXT NOT NULL,
    "male" INTEGER NOT NULL,
    "female" INTEGER NOT NULL,
    "source" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PopulationEstimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffAttendance" (
    "id" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "status" "StaffAttendanceStatus" NOT NULL,
    "clockedInAt" TIMESTAMP(3),
    "markedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportCode" (
    "code" TEXT NOT NULL,
    "studentId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportCode_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE INDEX "ExamPaper_termId_level_idx" ON "ExamPaper"("termId", "level");

-- CreateIndex
CREATE UNIQUE INDEX "ExamPaper_schoolId_termId_level_subjectCode_key" ON "ExamPaper"("schoolId", "termId", "level", "subjectCode");

-- CreateIndex
CREATE UNIQUE INDEX "PopulationEstimate_lga_year_stage_key" ON "PopulationEstimate"("lga", "year", "stage");

-- CreateIndex
CREATE INDEX "StaffAttendance_schoolId_date_idx" ON "StaffAttendance"("schoolId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "StaffAttendance_staffId_date_key" ON "StaffAttendance"("staffId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ReportCode_studentId_termId_key" ON "ReportCode"("studentId", "termId");

-- AddForeignKey
ALTER TABLE "ExamPaper" ADD CONSTRAINT "ExamPaper_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAttendance" ADD CONSTRAINT "StaffAttendance_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
