-- AlterTable: Add mode to Entry
ALTER TABLE "Entry" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'real';

-- CreateTable: StudentSurvey
CREATE TABLE "StudentSurvey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "competitionDate" TIMESTAMP(3) NOT NULL,
    "rating" INTEGER NOT NULL,
    "likes" TEXT NOT NULL,
    "dislikes" TEXT NOT NULL,
    "suggestions" TEXT NOT NULL,
    "bugReport" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StudentSurvey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex for StudentSurvey
CREATE INDEX "StudentSurvey_userId_idx" ON "StudentSurvey"("userId");

-- AddForeignKey for StudentSurvey
ALTER TABLE "StudentSurvey" ADD CONSTRAINT "StudentSurvey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: Forum
CREATE TABLE "Forum" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "imageUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "creatorId" TEXT NOT NULL,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Forum_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey for Forum
ALTER TABLE "Forum" ADD CONSTRAINT "Forum_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: ForumComment
CREATE TABLE "ForumComment" (
    "id" TEXT NOT NULL,
    "forumId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ForumComment_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey for ForumComment
ALTER TABLE "ForumComment" ADD CONSTRAINT "ForumComment_forumId_fkey" FOREIGN KEY ("forumId") REFERENCES "Forum"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ForumComment" ADD CONSTRAINT "ForumComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: ForumMember
CREATE TABLE "ForumMember" (
    "id" TEXT NOT NULL,
    "forumId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ForumMember_pkey" PRIMARY KEY ("id")
);

-- CreateUniqueIndex for ForumMember
CREATE UNIQUE INDEX "ForumMember_forumId_userId_key" ON "ForumMember"("forumId", "userId");

-- AddForeignKey for ForumMember
ALTER TABLE "ForumMember" ADD CONSTRAINT "ForumMember_forumId_fkey" FOREIGN KEY ("forumId") REFERENCES "Forum"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ForumMember" ADD CONSTRAINT "ForumMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: ForumLike
CREATE TABLE "ForumLike" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "forumId" TEXT,
    "commentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ForumLike_pkey" PRIMARY KEY ("id")
);

-- CreateUniqueIndex for ForumLike
CREATE UNIQUE INDEX "ForumLike_userId_targetId_key" ON "ForumLike"("userId", "targetId");

-- AddForeignKey for ForumLike
ALTER TABLE "ForumLike" ADD CONSTRAINT "ForumLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ForumLike" ADD CONSTRAINT "ForumLike_forumId_fkey" FOREIGN KEY ("forumId") REFERENCES "Forum"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ForumLike" ADD CONSTRAINT "ForumLike_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "ForumComment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
