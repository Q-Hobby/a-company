ALTER TABLE "bots" ADD COLUMN "modelCredentialId" TEXT;

CREATE INDEX "bots_modelCredentialId_userId_idx"
  ON "bots"("modelCredentialId", "userId");

ALTER TABLE "bots"
  ADD CONSTRAINT "bots_modelCredentialId_userId_fkey"
  FOREIGN KEY ("modelCredentialId", "userId")
  REFERENCES "user_model_credentials"("id", "userId")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
