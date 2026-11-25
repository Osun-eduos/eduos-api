-- CreateEnum
CREATE TYPE "SssGrading" AS ENUM ('WAEC', 'BASIC');

-- AlterTable
ALTER TABLE "Term" ADD COLUMN     "sssGrading" "SssGrading" NOT NULL DEFAULT 'WAEC';
