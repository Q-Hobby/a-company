-- Cascaded user deletion removes bots and credentials in separate RI steps, so even
-- NO ACTION trips mid-cascade. Defer the check to commit, when both rows are gone.
-- Deleting only a credential that a bot still pins keeps failing at commit.
ALTER TABLE "bots" DROP CONSTRAINT "bots_modelCredentialId_userId_fkey";

ALTER TABLE "bots"
  ADD CONSTRAINT "bots_modelCredentialId_userId_fkey"
  FOREIGN KEY ("modelCredentialId", "userId")
  REFERENCES "user_model_credentials"("id", "userId")
  ON DELETE NO ACTION
  ON UPDATE CASCADE
  DEFERRABLE INITIALLY DEFERRED;
