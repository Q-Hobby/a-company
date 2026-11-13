-- NO ACTION is checked at statement end, so deleting a user (which cascades to
-- both its bots and its credentials) succeeds; deleting only a pinned credential still fails.
ALTER TABLE "bots" DROP CONSTRAINT "bots_modelCredentialId_userId_fkey";

ALTER TABLE "bots"
  ADD CONSTRAINT "bots_modelCredentialId_userId_fkey"
  FOREIGN KEY ("modelCredentialId", "userId")
  REFERENCES "user_model_credentials"("id", "userId")
  ON DELETE NO ACTION
  ON UPDATE CASCADE;
