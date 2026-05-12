-- CreateTable
CREATE TABLE "course_enrollment" (
    "id" UUID NOT NULL,
    "legacyId" INTEGER,
    "memberId" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dateStart" TIMESTAMP(3),
    "dateEnd" TIMESTAMP(3),
    "expiredDate" TIMESTAMP(3),
    "isCanceled" BOOLEAN NOT NULL DEFAULT false,
    "cancelationReason" TEXT,
    "certificateCode" TEXT,
    "certificateCreated" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "course_enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "course_enrollment_legacyId_key" ON "course_enrollment"("legacyId");

-- CreateIndex
CREATE INDEX "course_enrollment_memberId_createdAt_idx" ON "course_enrollment"("memberId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "course_enrollment_memberId_courseId_key" ON "course_enrollment"("memberId", "courseId");

-- AddForeignKey
ALTER TABLE "course_enrollment" ADD CONSTRAINT "course_enrollment_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_enrollment" ADD CONSTRAINT "course_enrollment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
