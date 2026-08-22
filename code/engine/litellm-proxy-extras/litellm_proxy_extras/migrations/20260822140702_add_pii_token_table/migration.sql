-- CreateTable
CREATE TABLE "LiteLLM_PiiTokenTable" (
    "token_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "algorithm" TEXT NOT NULL DEFAULT 'aes-256-gcm',
    "scope_type" TEXT NOT NULL,
    "scope_id" TEXT NOT NULL,
    "session_id" TEXT,
    "subject_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "expires_at" TIMESTAMP(3),
    "last_accessed_at" TIMESTAMP(3),

    CONSTRAINT "LiteLLM_PiiTokenTable_pkey" PRIMARY KEY ("token_id")
);

-- CreateIndex
CREATE INDEX "LiteLLM_PiiTokenTable_scope_type_scope_id_idx" ON "LiteLLM_PiiTokenTable"("scope_type", "scope_id");

-- CreateIndex
CREATE INDEX "LiteLLM_PiiTokenTable_session_id_idx" ON "LiteLLM_PiiTokenTable"("session_id");

-- CreateIndex
CREATE INDEX "LiteLLM_PiiTokenTable_expires_at_idx" ON "LiteLLM_PiiTokenTable"("expires_at");

-- CreateIndex
CREATE INDEX "LiteLLM_PiiTokenTable_scope_type_scope_id_entity_type_idx" ON "LiteLLM_PiiTokenTable"("scope_type", "scope_id", "entity_type");

-- CreateIndex
CREATE INDEX "LiteLLM_PiiTokenTable_subject_id_idx" ON "LiteLLM_PiiTokenTable"("subject_id");

