-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."CapsuleReleaseType" AS ENUM ('SCHEDULED_DATE', 'RECURRING_ANNUAL', 'GUARDIAN_CONTROLLED');

-- CreateEnum
CREATE TYPE "public"."CapsuleStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PENDING_GUARDIAN_RELEASE', 'RELEASING', 'RELEASED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."DeliveryChannel" AS ENUM ('EMAIL', 'IN_APP');

-- CreateEnum
CREATE TYPE "public"."DeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'BOUNCED', 'RETURNED_TO_GUARDIAN', 'DELIVERED');

-- CreateEnum
CREATE TYPE "public"."EulogyProvider" AS ENUM ('ANTHROPIC', 'OPENAI', 'GOOGLE');

-- CreateEnum
CREATE TYPE "public"."GuardianInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "public"."MemorialActivationStatus" AS ENUM ('PENDING_REVIEW', 'ACTIVE', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."MemorialPrivacy" AS ENUM ('PUBLIC', 'INVITE_ONLY', 'PRIVATE');

-- CreateEnum
CREATE TYPE "public"."ModerationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'AUTO_BLOCKED');

-- CreateEnum
CREATE TYPE "public"."NotificationType" AS ENUM ('CAPSULE_RELEASED', 'GUESTBOOK_ENTRY_NEW', 'STORY_APPROVED', 'STORY_SUBMITTED', 'GUARDIAN_INVITED', 'GUARDIAN_ACCEPTED', 'GUARDIAN_DECLINED', 'MEMORIAL_ACTIVATED', 'MEDIA_VIDEO_UPLOADED', 'MEDIA_PDF_UPLOADED', 'CAPSULE_BOUNCED_RETURNED', 'STORAGE_WARNING');

-- CreateEnum
CREATE TYPE "public"."OAuthProvider" AS ENUM ('GOOGLE', 'APPLE', 'FACEBOOK');

-- CreateEnum
CREATE TYPE "public"."PlatformRole" AS ENUM ('USER', 'SUPPORT_AGENT', 'ADMIN');

-- CreateEnum
CREATE TYPE "public"."SubscriptionPlan" AS ENUM ('FREE', 'BASIC', 'FAMILY', 'LEGACY_PREMIUM');

-- CreateEnum
CREATE TYPE "public"."SubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELLED', 'INCOMPLETE');

-- CreateEnum
CREATE TYPE "public"."UploadStatus" AS ENUM ('PENDING_UPLOAD', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."VaultItemType" AS ENUM ('PHOTO', 'VIDEO', 'AUDIO', 'DOCUMENT', 'WRITTEN');

-- CreateTable
CREATE TABLE "public"."AuditLog" (
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
CREATE TABLE "public"."CapsuleDelivery" (
    "id" UUID NOT NULL,
    "capsuleId" UUID NOT NULL,
    "channel" "public"."DeliveryChannel" NOT NULL DEFAULT 'EMAIL',
    "status" "public"."DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
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
CREATE TABLE "public"."EmailVerificationToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'VERIFY_EMAIL',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "EmailVerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Eulogy" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "pageId" UUID,
    "promptAnswers" JSONB NOT NULL,
    "draftText" TEXT NOT NULL,
    "provider" "public"."EulogyProvider" NOT NULL DEFAULT 'ANTHROPIC',
    "model" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Eulogy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."GuardianInvitation" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "guardianEmail" TEXT NOT NULL,
    "guardianId" UUID,
    "status" "public"."GuardianInvitationStatus" NOT NULL DEFAULT 'PENDING',
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
CREATE TABLE "public"."GuestbookEntry" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "authorUserId" UUID,
    "authorName" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "public"."ModerationStatus" NOT NULL DEFAULT 'PENDING',
    "moderationReason" TEXT,
    "reportCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestbookEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MemorialActivation" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "activatedById" UUID NOT NULL,
    "deathCertificateKey" TEXT NOT NULL,
    "status" "public"."MemorialActivationStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "activatedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "reviewedByAdminId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemorialActivation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MemorialPage" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "deceasedName" TEXT NOT NULL,
    "deceasedUserId" UUID,
    "creatorUserId" UUID NOT NULL,
    "managerUserId" UUID,
    "biography" TEXT,
    "privacy" "public"."MemorialPrivacy" NOT NULL DEFAULT 'INVITE_ONLY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemorialPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MemorialPageCollaborator" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "canEdit" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemorialPageCollaborator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MemorialPageInvitation" (
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
CREATE TABLE "public"."MemorialPagePhoto" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "uploadedById" UUID NOT NULL,
    "s3Key" TEXT NOT NULL,
    "caption" TEXT,
    "status" "public"."ModerationStatus" NOT NULL DEFAULT 'PENDING',
    "moderationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemorialPagePhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "public"."NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OAuthAccount" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "public"."OAuthProvider" NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Session" (
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
CREATE TABLE "public"."StorySubmission" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "authorUserId" UUID,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "status" "public"."ModerationStatus" NOT NULL DEFAULT 'PENDING',
    "moderationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorySubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Subscription" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "plan" "public"."SubscriptionPlan" NOT NULL DEFAULT 'FREE',
    "status" "public"."SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TimeCapsule" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT,
    "mediaItemId" UUID,
    "recipientUserId" UUID,
    "recipientEmail" TEXT NOT NULL,
    "releaseType" "public"."CapsuleReleaseType" NOT NULL,
    "status" "public"."CapsuleStatus" NOT NULL DEFAULT 'DRAFT',
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
CREATE TABLE "public"."TimelineEvent" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "eventDate" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."User" (
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
    "platformRole" "public"."PlatformRole" NOT NULL DEFAULT 'USER',
    "plan" "public"."SubscriptionPlan" NOT NULL DEFAULT 'FREE',
    "storageUsedBytes" BIGINT NOT NULL DEFAULT 0,
    "isDeceased" BOOLEAN NOT NULL DEFAULT false,
    "suspendedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Vault" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vault_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."VaultFolder" (
    "id" UUID NOT NULL,
    "vaultId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VaultFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."VaultItem" (
    "id" UUID NOT NULL,
    "vaultId" UUID NOT NULL,
    "folderId" UUID,
    "type" "public"."VaultItemType" NOT NULL,
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
    "uploadStatus" "public"."UploadStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VaultItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "public"."AuditLog"("actorId" ASC);

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "public"."AuditLog"("createdAt" ASC);

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "public"."AuditLog"("targetType" ASC, "targetId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "CapsuleDelivery_capsuleId_occurrenceYear_key" ON "public"."CapsuleDelivery"("capsuleId" ASC, "occurrenceYear" ASC);

-- CreateIndex
CREATE INDEX "CapsuleDelivery_status_idx" ON "public"."CapsuleDelivery"("status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerificationToken_tokenHash_key" ON "public"."EmailVerificationToken"("tokenHash" ASC);

-- CreateIndex
CREATE INDEX "EmailVerificationToken_userId_idx" ON "public"."EmailVerificationToken"("userId" ASC);

-- CreateIndex
CREATE INDEX "Eulogy_ownerId_idx" ON "public"."Eulogy"("ownerId" ASC);

-- CreateIndex
CREATE INDEX "GuardianInvitation_guardianId_idx" ON "public"."GuardianInvitation"("guardianId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "GuardianInvitation_ownerId_guardianEmail_key" ON "public"."GuardianInvitation"("ownerId" ASC, "guardianEmail" ASC);

-- CreateIndex
CREATE INDEX "GuardianInvitation_status_idx" ON "public"."GuardianInvitation"("status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "GuardianInvitation_tokenHash_key" ON "public"."GuardianInvitation"("tokenHash" ASC);

-- CreateIndex
CREATE INDEX "GuestbookEntry_pageId_status_idx" ON "public"."GuestbookEntry"("pageId" ASC, "status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "MemorialActivation_ownerId_key" ON "public"."MemorialActivation"("ownerId" ASC);

-- CreateIndex
CREATE INDEX "MemorialPage_creatorUserId_idx" ON "public"."MemorialPage"("creatorUserId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "MemorialPage_deceasedUserId_key" ON "public"."MemorialPage"("deceasedUserId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "MemorialPage_slug_key" ON "public"."MemorialPage"("slug" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "MemorialPageCollaborator_pageId_userId_key" ON "public"."MemorialPageCollaborator"("pageId" ASC, "userId" ASC);

-- CreateIndex
CREATE INDEX "MemorialPageInvitation_pageId_idx" ON "public"."MemorialPageInvitation"("pageId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "MemorialPageInvitation_tokenHash_key" ON "public"."MemorialPageInvitation"("tokenHash" ASC);

-- CreateIndex
CREATE INDEX "MemorialPagePhoto_pageId_status_idx" ON "public"."MemorialPagePhoto"("pageId" ASC, "status" ASC);

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "public"."Notification"("userId" ASC, "readAt" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAccount_provider_providerAccountId_key" ON "public"."OAuthAccount"("provider" ASC, "providerAccountId" ASC);

-- CreateIndex
CREATE INDEX "OAuthAccount_userId_idx" ON "public"."OAuthAccount"("userId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenId_key" ON "public"."Session"("tokenId" ASC);

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "public"."Session"("userId" ASC);

-- CreateIndex
CREATE INDEX "StorySubmission_pageId_status_idx" ON "public"."StorySubmission"("pageId" ASC, "status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_userId_key" ON "public"."Subscription"("userId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "TimeCapsule_mediaItemId_key" ON "public"."TimeCapsule"("mediaItemId" ASC);

-- CreateIndex
CREATE INDEX "TimeCapsule_ownerId_idx" ON "public"."TimeCapsule"("ownerId" ASC);

-- CreateIndex
CREATE INDEX "TimeCapsule_releaseType_idx" ON "public"."TimeCapsule"("releaseType" ASC);

-- CreateIndex
CREATE INDEX "TimeCapsule_status_releaseAt_idx" ON "public"."TimeCapsule"("status" ASC, "releaseAt" ASC);

-- CreateIndex
CREATE INDEX "TimelineEvent_pageId_idx" ON "public"."TimelineEvent"("pageId" ASC);

-- CreateIndex
CREATE INDEX "User_email_idx" ON "public"."User"("email" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email" ASC);

-- CreateIndex
CREATE INDEX "User_isLegacyOwner_idx" ON "public"."User"("isLegacyOwner" ASC);

-- CreateIndex
CREATE INDEX "User_platformRole_idx" ON "public"."User"("platformRole" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Vault_userId_key" ON "public"."Vault"("userId" ASC);

-- CreateIndex
CREATE INDEX "VaultFolder_vaultId_idx" ON "public"."VaultFolder"("vaultId" ASC);

-- CreateIndex
CREATE INDEX "VaultItem_type_idx" ON "public"."VaultItem"("type" ASC);

-- CreateIndex
CREATE INDEX "VaultItem_vaultId_idx" ON "public"."VaultItem"("vaultId" ASC);

-- AddForeignKey
ALTER TABLE "public"."AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CapsuleDelivery" ADD CONSTRAINT "CapsuleDelivery_capsuleId_fkey" FOREIGN KEY ("capsuleId") REFERENCES "public"."TimeCapsule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EmailVerificationToken" ADD CONSTRAINT "EmailVerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Eulogy" ADD CONSTRAINT "Eulogy_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GuardianInvitation" ADD CONSTRAINT "GuardianInvitation_guardianId_fkey" FOREIGN KEY ("guardianId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GuardianInvitation" ADD CONSTRAINT "GuardianInvitation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GuestbookEntry" ADD CONSTRAINT "GuestbookEntry_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GuestbookEntry" ADD CONSTRAINT "GuestbookEntry_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "public"."MemorialPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MemorialActivation" ADD CONSTRAINT "MemorialActivation_activatedById_fkey" FOREIGN KEY ("activatedById") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MemorialActivation" ADD CONSTRAINT "MemorialActivation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MemorialPage" ADD CONSTRAINT "MemorialPage_creatorUserId_fkey" FOREIGN KEY ("creatorUserId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MemorialPage" ADD CONSTRAINT "MemorialPage_deceasedUserId_fkey" FOREIGN KEY ("deceasedUserId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MemorialPageCollaborator" ADD CONSTRAINT "MemorialPageCollaborator_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "public"."MemorialPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MemorialPageCollaborator" ADD CONSTRAINT "MemorialPageCollaborator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MemorialPageInvitation" ADD CONSTRAINT "MemorialPageInvitation_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "public"."MemorialPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MemorialPagePhoto" ADD CONSTRAINT "MemorialPagePhoto_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "public"."MemorialPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OAuthAccount" ADD CONSTRAINT "OAuthAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StorySubmission" ADD CONSTRAINT "StorySubmission_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StorySubmission" ADD CONSTRAINT "StorySubmission_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "public"."MemorialPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TimeCapsule" ADD CONSTRAINT "TimeCapsule_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "public"."VaultItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TimeCapsule" ADD CONSTRAINT "TimeCapsule_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TimeCapsule" ADD CONSTRAINT "TimeCapsule_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TimelineEvent" ADD CONSTRAINT "TimelineEvent_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "public"."MemorialPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Vault" ADD CONSTRAINT "Vault_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."VaultFolder" ADD CONSTRAINT "VaultFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "public"."VaultFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."VaultFolder" ADD CONSTRAINT "VaultFolder_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "public"."Vault"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."VaultItem" ADD CONSTRAINT "VaultItem_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "public"."VaultFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."VaultItem" ADD CONSTRAINT "VaultItem_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "public"."Vault"("id") ON DELETE CASCADE ON UPDATE CASCADE;

