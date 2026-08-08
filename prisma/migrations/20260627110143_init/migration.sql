-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('USER', 'SUPPORT_AGENT', 'ADMIN');

-- CreateEnum
CREATE TYPE "OAuthProvider" AS ENUM ('GOOGLE', 'APPLE', 'FACEBOOK');

-- CreateEnum
CREATE TYPE "SubscriptionPlan" AS ENUM ('FREE', 'BASIC', 'FAMILY', 'LEGACY_PREMIUM');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELLED', 'INCOMPLETE');

-- CreateEnum
CREATE TYPE "VaultItemType" AS ENUM ('PHOTO', 'VIDEO', 'AUDIO', 'DOCUMENT', 'WRITTEN');

-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('PENDING_UPLOAD', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "GuardianInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "MemorialActivationStatus" AS ENUM ('PENDING_REVIEW', 'ACTIVE', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CapsuleReleaseType" AS ENUM ('SCHEDULED_DATE', 'RECURRING_ANNUAL', 'GUARDIAN_CONTROLLED');

-- CreateEnum
CREATE TYPE "CapsuleStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PENDING_GUARDIAN_RELEASE', 'RELEASING', 'RELEASED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryChannel" AS ENUM ('EMAIL', 'IN_APP');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'BOUNCED', 'RETURNED_TO_GUARDIAN', 'DELIVERED');

-- CreateEnum
CREATE TYPE "MemorialPrivacy" AS ENUM ('PUBLIC', 'INVITE_ONLY', 'PRIVATE');

-- CreateEnum
CREATE TYPE "ModerationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'AUTO_BLOCKED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('CAPSULE_RELEASED', 'GUESTBOOK_ENTRY_NEW', 'STORY_APPROVED', 'STORY_SUBMITTED', 'GUARDIAN_INVITED', 'GUARDIAN_ACCEPTED', 'GUARDIAN_DECLINED', 'MEMORIAL_ACTIVATED', 'MEDIA_VIDEO_UPLOADED', 'MEDIA_PDF_UPLOADED', 'CAPSULE_BOUNCED_RETURNED', 'STORAGE_WARNING');

-- CreateEnum
CREATE TYPE "EulogyProvider" AS ENUM ('ANTHROPIC', 'OPENAI', 'GOOGLE');

-- CreateEnum
CREATE TYPE "MemoryVisibility" AS ENUM ('PRIVATE', 'SHARED', 'PUBLIC');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "fullName" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "avatarKey" TEXT,
    "emailVerifiedAt" TIMESTAMP(3),
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "totpSecret" TEXT,
    "totpRecoveryHash" TEXT,
    "isFamilyUser" BOOLEAN NOT NULL DEFAULT true,
    "isLegacyOwner" BOOLEAN NOT NULL DEFAULT false,
    "isGuardian" BOOLEAN NOT NULL DEFAULT false,
    "platformRole" "PlatformRole" NOT NULL DEFAULT 'USER',
    "plan" "SubscriptionPlan" NOT NULL DEFAULT 'FREE',
    "storageUsedBytes" BIGINT NOT NULL DEFAULT 0,
    "isDeceased" BOOLEAN NOT NULL DEFAULT false,
    "suspendedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthAccount" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "OAuthProvider" NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenId" TEXT NOT NULL,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailVerificationToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'VERIFY_EMAIL',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "plan" "SubscriptionPlan" NOT NULL DEFAULT 'FREE',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vault" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vault_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaultFolder" (
    "id" UUID NOT NULL,
    "vaultId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VaultFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaultItem" (
    "id" UUID NOT NULL,
    "vaultId" UUID NOT NULL,
    "folderId" UUID,
    "type" "VaultItemType" NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "bodyText" TEXT,
    "s3Key" TEXT,
    "mimeType" TEXT,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "durationSec" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "hlsManifestKey" TEXT,
    "uploadStatus" "UploadStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VaultItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuardianInvitation" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "guardianEmail" TEXT NOT NULL,
    "guardianId" UUID,
    "status" "GuardianInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuardianInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemorialActivation" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "activatedById" UUID NOT NULL,
    "deathCertificateKey" TEXT NOT NULL,
    "status" "MemorialActivationStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "activatedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "reviewedByAdminId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemorialActivation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeCapsule" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT,
    "mediaItemId" UUID,
    "recipientUserId" UUID,
    "recipientEmail" TEXT NOT NULL,
    "releaseType" "CapsuleReleaseType" NOT NULL,
    "status" "CapsuleStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduleTimezone" TEXT NOT NULL,
    "releaseAt" TIMESTAMP(3),
    "recurMonth" INTEGER,
    "recurDay" INTEGER,
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "guardianControlled" BOOLEAN NOT NULL DEFAULT false,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeCapsule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapsuleDelivery" (
    "id" UUID NOT NULL,
    "capsuleId" UUID NOT NULL,
    "channel" "DeliveryChannel" NOT NULL DEFAULT 'EMAIL',
    "status" "DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "toEmail" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "occurrenceYear" INTEGER,
    "sentAt" TIMESTAMP(3),
    "bouncedAt" TIMESTAMP(3),
    "returnedToGuardianId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CapsuleDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemorialPage" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "deceasedName" TEXT NOT NULL,
    "deceasedUserId" UUID,
    "creatorUserId" UUID NOT NULL,
    "managerUserId" UUID,
    "biography" TEXT,
    "privacy" "MemorialPrivacy" NOT NULL DEFAULT 'INVITE_ONLY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemorialPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemorialPagePhoto" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "uploadedById" UUID NOT NULL,
    "s3Key" TEXT NOT NULL,
    "caption" TEXT,
    "status" "ModerationStatus" NOT NULL DEFAULT 'PENDING',
    "moderationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemorialPagePhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemorialPageCollaborator" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "canEdit" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemorialPageCollaborator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemorialPageInvitation" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemorialPageInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuestbookEntry" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "authorUserId" UUID,
    "authorName" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "ModerationStatus" NOT NULL DEFAULT 'PENDING',
    "moderationReason" TEXT,
    "reportCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestbookEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorySubmission" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "authorUserId" UUID,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "status" "ModerationStatus" NOT NULL DEFAULT 'PENDING',
    "moderationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorySubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimelineEvent" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "eventDate" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Eulogy" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "pageId" UUID,
    "promptAnswers" JSONB NOT NULL,
    "draftText" TEXT NOT NULL,
    "provider" "EulogyProvider" NOT NULL DEFAULT 'ANTHROPIC',
    "model" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Eulogy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Memory" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "story" TEXT,
    "contentType" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "durationSec" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "thumbnailKey" TEXT,
    "folderId" UUID,
    "visibility" "MemoryVisibility" NOT NULL DEFAULT 'PRIVATE',
    "status" "UploadStatus" NOT NULL DEFAULT 'READY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Folder" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "parentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Folder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryTag" (
    "memoryId" UUID NOT NULL,
    "tagId" UUID NOT NULL,

    CONSTRAINT "MemoryTag_pkey" PRIMARY KEY ("memoryId","tagId")
);

-- CreateTable
CREATE TABLE "VoiceRecording" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "duration" INTEGER NOT NULL DEFAULT 0,
    "contentType" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "folderId" UUID,
    "status" "UploadStatus" NOT NULL DEFAULT 'READY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "VoiceRecording_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_isLegacyOwner_idx" ON "User"("isLegacyOwner");

-- CreateIndex
CREATE INDEX "User_platformRole_idx" ON "User"("platformRole");

-- CreateIndex
CREATE INDEX "OAuthAccount_userId_idx" ON "OAuthAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAccount_provider_providerAccountId_key" ON "OAuthAccount"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenId_key" ON "Session"("tokenId");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerificationToken_tokenHash_key" ON "EmailVerificationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailVerificationToken_userId_idx" ON "EmailVerificationToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Vault_userId_key" ON "Vault"("userId");

-- CreateIndex
CREATE INDEX "VaultFolder_vaultId_idx" ON "VaultFolder"("vaultId");

-- CreateIndex
CREATE INDEX "VaultItem_vaultId_idx" ON "VaultItem"("vaultId");

-- CreateIndex
CREATE INDEX "VaultItem_type_idx" ON "VaultItem"("type");

-- CreateIndex
CREATE UNIQUE INDEX "GuardianInvitation_tokenHash_key" ON "GuardianInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "GuardianInvitation_guardianId_idx" ON "GuardianInvitation"("guardianId");

-- CreateIndex
CREATE INDEX "GuardianInvitation_status_idx" ON "GuardianInvitation"("status");

-- CreateIndex
CREATE UNIQUE INDEX "GuardianInvitation_ownerId_guardianEmail_key" ON "GuardianInvitation"("ownerId", "guardianEmail");

-- CreateIndex
CREATE UNIQUE INDEX "MemorialActivation_ownerId_key" ON "MemorialActivation"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "TimeCapsule_mediaItemId_key" ON "TimeCapsule"("mediaItemId");

-- CreateIndex
CREATE INDEX "TimeCapsule_ownerId_idx" ON "TimeCapsule"("ownerId");

-- CreateIndex
CREATE INDEX "TimeCapsule_status_releaseAt_idx" ON "TimeCapsule"("status", "releaseAt");

-- CreateIndex
CREATE INDEX "TimeCapsule_releaseType_idx" ON "TimeCapsule"("releaseType");

-- CreateIndex
CREATE INDEX "CapsuleDelivery_status_idx" ON "CapsuleDelivery"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CapsuleDelivery_capsuleId_occurrenceYear_key" ON "CapsuleDelivery"("capsuleId", "occurrenceYear");

-- CreateIndex
CREATE UNIQUE INDEX "MemorialPage_slug_key" ON "MemorialPage"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "MemorialPage_deceasedUserId_key" ON "MemorialPage"("deceasedUserId");

-- CreateIndex
CREATE INDEX "MemorialPage_creatorUserId_idx" ON "MemorialPage"("creatorUserId");

-- CreateIndex
CREATE INDEX "MemorialPagePhoto_pageId_status_idx" ON "MemorialPagePhoto"("pageId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MemorialPageCollaborator_pageId_userId_key" ON "MemorialPageCollaborator"("pageId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "MemorialPageInvitation_tokenHash_key" ON "MemorialPageInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "MemorialPageInvitation_pageId_idx" ON "MemorialPageInvitation"("pageId");

-- CreateIndex
CREATE INDEX "GuestbookEntry_pageId_status_idx" ON "GuestbookEntry"("pageId", "status");

-- CreateIndex
CREATE INDEX "StorySubmission_pageId_status_idx" ON "StorySubmission"("pageId", "status");

-- CreateIndex
CREATE INDEX "TimelineEvent_pageId_idx" ON "TimelineEvent"("pageId");

-- CreateIndex
CREATE INDEX "Eulogy_ownerId_idx" ON "Eulogy"("ownerId");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Memory_fileKey_key" ON "Memory"("fileKey");

-- CreateIndex
CREATE INDEX "Memory_userId_createdAt_idx" ON "Memory"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Memory_userId_visibility_idx" ON "Memory"("userId", "visibility");

-- CreateIndex
CREATE INDEX "Memory_userId_folderId_idx" ON "Memory"("userId", "folderId");

-- CreateIndex
CREATE INDEX "Memory_userId_deletedAt_idx" ON "Memory"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "Folder_userId_idx" ON "Folder"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Folder_userId_parentId_name_key" ON "Folder"("userId", "parentId", "name");

-- CreateIndex
CREATE INDEX "Tag_userId_idx" ON "Tag"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_userId_name_key" ON "Tag"("userId", "name");

-- CreateIndex
CREATE INDEX "MemoryTag_tagId_idx" ON "MemoryTag"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceRecording_fileKey_key" ON "VoiceRecording"("fileKey");

-- CreateIndex
CREATE INDEX "VoiceRecording_userId_createdAt_idx" ON "VoiceRecording"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "VoiceRecording_userId_deletedAt_idx" ON "VoiceRecording"("userId", "deletedAt");

-- AddForeignKey
ALTER TABLE "OAuthAccount" ADD CONSTRAINT "OAuthAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailVerificationToken" ADD CONSTRAINT "EmailVerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vault" ADD CONSTRAINT "Vault_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultFolder" ADD CONSTRAINT "VaultFolder_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "Vault"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultFolder" ADD CONSTRAINT "VaultFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "VaultFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultItem" ADD CONSTRAINT "VaultItem_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "Vault"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultItem" ADD CONSTRAINT "VaultItem_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "VaultFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianInvitation" ADD CONSTRAINT "GuardianInvitation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianInvitation" ADD CONSTRAINT "GuardianInvitation_guardianId_fkey" FOREIGN KEY ("guardianId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemorialActivation" ADD CONSTRAINT "MemorialActivation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemorialActivation" ADD CONSTRAINT "MemorialActivation_activatedById_fkey" FOREIGN KEY ("activatedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeCapsule" ADD CONSTRAINT "TimeCapsule_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeCapsule" ADD CONSTRAINT "TimeCapsule_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "VaultItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeCapsule" ADD CONSTRAINT "TimeCapsule_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapsuleDelivery" ADD CONSTRAINT "CapsuleDelivery_capsuleId_fkey" FOREIGN KEY ("capsuleId") REFERENCES "TimeCapsule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemorialPage" ADD CONSTRAINT "MemorialPage_deceasedUserId_fkey" FOREIGN KEY ("deceasedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemorialPage" ADD CONSTRAINT "MemorialPage_creatorUserId_fkey" FOREIGN KEY ("creatorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemorialPagePhoto" ADD CONSTRAINT "MemorialPagePhoto_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "MemorialPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemorialPageCollaborator" ADD CONSTRAINT "MemorialPageCollaborator_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "MemorialPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemorialPageCollaborator" ADD CONSTRAINT "MemorialPageCollaborator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemorialPageInvitation" ADD CONSTRAINT "MemorialPageInvitation_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "MemorialPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestbookEntry" ADD CONSTRAINT "GuestbookEntry_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "MemorialPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestbookEntry" ADD CONSTRAINT "GuestbookEntry_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorySubmission" ADD CONSTRAINT "StorySubmission_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "MemorialPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorySubmission" ADD CONSTRAINT "StorySubmission_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "MemorialPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Eulogy" ADD CONSTRAINT "Eulogy_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Folder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryTag" ADD CONSTRAINT "MemoryTag_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "Memory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryTag" ADD CONSTRAINT "MemoryTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceRecording" ADD CONSTRAINT "VoiceRecording_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceRecording" ADD CONSTRAINT "VoiceRecording_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
