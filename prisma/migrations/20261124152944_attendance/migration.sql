-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED');

-- CreateTable
CREATE TABLE "AttendanceRegister" (
    "id" UUID NOT NULL,
    "classArmId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "takenById" UUID NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceRegister_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceMark" (
    "id" UUID NOT NULL,
    "registerId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "note" TEXT,

    CONSTRAINT "AttendanceMark_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttendanceRegister_date_idx" ON "AttendanceRegister"("date");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceRegister_classArmId_date_key" ON "AttendanceRegister"("classArmId", "date");

-- CreateIndex
CREATE INDEX "AttendanceMark_studentId_idx" ON "AttendanceMark"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceMark_registerId_studentId_key" ON "AttendanceMark"("registerId", "studentId");

-- AddForeignKey
ALTER TABLE "AttendanceRegister" ADD CONSTRAINT "AttendanceRegister_classArmId_fkey" FOREIGN KEY ("classArmId") REFERENCES "ClassArm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRegister" ADD CONSTRAINT "AttendanceRegister_takenById_fkey" FOREIGN KEY ("takenById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRegister" ADD CONSTRAINT "AttendanceRegister_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceMark" ADD CONSTRAINT "AttendanceMark_registerId_fkey" FOREIGN KEY ("registerId") REFERENCES "AttendanceRegister"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceMark" ADD CONSTRAINT "AttendanceMark_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
