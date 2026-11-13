import { waitForModelOAuthCompletion } from "@acompany/core";
import { rpc } from "./rpc";

export type { ModelCatalogEntry, ModelCredential, ModelOAuthBegin } from "@acompany/contracts";
export { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@acompany/core";

export async function waitForModelOAuth(loginId: string, signal?: AbortSignal) {
  return waitForModelOAuthCompletion(() => rpc.models.completeOAuth({ loginId }, { signal }), {
    signal,
  });
}
