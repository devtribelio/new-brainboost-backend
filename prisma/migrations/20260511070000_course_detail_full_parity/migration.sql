-- AlterTable
ALTER TABLE "course_lessons" ADD COLUMN     "code" TEXT,
ADD COLUMN     "duration" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "isPreview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "legacyLessonId" SERIAL NOT NULL,
ADD COLUMN     "lessonStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "slug" TEXT;

-- AlterTable
ALTER TABLE "course_sections" ADD COLUMN     "legacySectionId" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "course_lessons_legacyLessonId_key" ON "course_lessons"("legacyLessonId");

-- CreateIndex
CREATE UNIQUE INDEX "course_lessons_code_key" ON "course_lessons"("code");

-- CreateIndex
CREATE UNIQUE INDEX "course_sections_legacySectionId_key" ON "course_sections"("legacySectionId");

