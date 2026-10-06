CREATE TABLE IF NOT EXISTS "AiPrompt" (
  "id"        UUID         NOT NULL PRIMARY KEY,
  "ownerId"   UUID         NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "question"  TEXT         NOT NULL,
  "answer"    TEXT         NOT NULL,
  "model"     TEXT         NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "AiPrompt_ownerId_createdAt_idx"
  ON "AiPrompt"("ownerId", "createdAt");
