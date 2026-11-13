import type { ModelOAuthBegin } from "@acompany/contracts";
import { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@acompany/core";
import { t } from "@lingui/core/macro";
import { useEffect, useRef, useState } from "react";
import { desktopBridge, oauthStateOf, onDesktopOAuthCallback } from "./desktop";
import { waitForModelOAuth } from "./model-auth";
import { rpc } from "./rpc";

export type ModelOAuthSignInBegin = {
  provider: string;
  modelId?: string;
  label?: string;
  credentialId?: string;
  createNew?: boolean;
};

/**
 * One polling/finish lifecycle for backend callbacks, desktop loopback capture,
 * and manual paste. Attempt-owned guards keep cancel-and-retry isolated.
 */
export function useModelOAuthSignIn(options: {
  onFinished: (controller: AbortController) => void | Promise<void>;
  onError: (message: string) => void;
  onClearError?: () => void;
}) {
  const { onFinished, onError, onClearError } = options;
  const [oauth, setOauth] = useState<ModelOAuthBegin | null>(null);
  const [pasteCode, setPasteCode] = useState("");
  const [oauthPending, setOauthPending] = useState(false);
  const oauthAbortRef = useRef<AbortController | null>(null);
  const oauthLoginIdRef = useRef<string | null>(null);
  const oauthCodeSubmittingRef = useRef(false);
  const oauthCaptureRef = useRef<(() => void) | null>(null);
  const onFinishedRef = useRef(onFinished);
  const onErrorRef = useRef(onError);
  const onClearErrorRef = useRef(onClearError);
  onFinishedRef.current = onFinished;
  onErrorRef.current = onError;
  onClearErrorRef.current = onClearError;

  function releaseOAuthCapture() {
    oauthCaptureRef.current?.();
    oauthCaptureRef.current = null;
  }

  function cancelOAuthAttempt(resetState = true) {
    releaseOAuthCapture();
    oauthCodeSubmittingRef.current = false;
    const loginId = oauthLoginIdRef.current;
    oauthLoginIdRef.current = null;
    cancelModelOAuthAttempt(oauthAbortRef, () => {
      if (resetState) {
        setOauth(null);
        setOauthPending(false);
      }
    });
    if (loginId) void rpc.models.cancelOAuth({ loginId }).catch(() => undefined);
  }

  async function finishSubscriptionSignIn(loginId: string, controller: AbortController) {
    await waitForModelOAuth(loginId, controller.signal);
    if (controller.signal.aborted) return;
    await rpc.models.finishOAuth({ loginId }, { signal: controller.signal });
    if (controller.signal.aborted) return;
    oauthLoginIdRef.current = null;
    setOauth(null);
    // Keep post-connect UI work outside the OAuth try/catch so a refresh failure
    // is not reported as a failed sign-in (finishOAuth already persisted).
    try {
      await onFinishedRef.current(controller);
    } catch {
      if (controller.signal.aborted) return;
      onErrorRef.current(t`Saved, but list refresh failed`);
    }
  }

  async function submitOAuthCode(captured?: string, login?: ModelOAuthBegin) {
    const attempt = login ?? oauth;
    if (attempt?.mode !== "auth-url" || oauthCodeSubmittingRef.current) return;
    const controller = oauthAbortRef.current;
    const code = (captured ?? pasteCode).trim();
    if (
      !controller ||
      controller.signal.aborted ||
      oauthLoginIdRef.current !== attempt.loginId ||
      !code
    )
      return;
    oauthCodeSubmittingRef.current = true;
    setPasteCode("");
    onClearErrorRef.current?.();
    try {
      // Only deliver the code. The start-owned poll is the sole finisher, and
      // retains capture/busy ownership until persistence actually completes.
      await rpc.models.submitOAuthCode(
        { loginId: attempt.loginId, code },
        { signal: controller.signal },
      );
    } catch {
      if (
        controller.signal.aborted ||
        oauthAbortRef.current !== controller ||
        oauthLoginIdRef.current !== attempt.loginId
      )
        return;
      oauthCodeSubmittingRef.current = false;
      setPasteCode(code);
      // Provider/RPC errors may echo the callback code or URL.
      onErrorRef.current(t`Could not connect this provider`);
    }
  }

  async function startSubscriptionSignIn(begin: ModelOAuthSignInBegin) {
    cancelOAuthAttempt();
    onClearErrorRef.current?.();
    setOauthPending(true);
    const controller = new AbortController();
    oauthAbortRef.current = controller;

    try {
      const started = await rpc.models.beginOAuth(
        {
          provider: begin.provider,
          modelId: begin.modelId,
          label: begin.label,
          credentialId: begin.credentialId,
          createNew: begin.createNew,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) {
        void rpc.models.cancelOAuth({ loginId: started.loginId }).catch(() => undefined);
        return;
      }
      oauthLoginIdRef.current = started.loginId;
      setPasteCode("");
      setOauth(started);
      if (started.mode === "auth-url") {
        // Subscribe before the popup exists: a provider that is already
        // authorized can redirect before React commits the state above.
        releaseOAuthCapture();
        oauthCaptureRef.current = onDesktopOAuthCallback((code) => {
          if (oauthAbortRef.current === controller && !controller.signal.aborted) {
            void submitOAuthCode(code, started);
          }
        }, oauthStateOf(started.verificationUri));
      }
      const browserAuth = desktopBridge()?.oauth;
      if (browserAuth?.open) {
        const cancelBrowser = () =>
          void browserAuth.cancel?.(started.verificationUri).catch(() => undefined);
        controller.signal.addEventListener("abort", cancelBrowser, { once: true });
        const releaseCapture = oauthCaptureRef.current;
        oauthCaptureRef.current = () => {
          releaseCapture?.();
          controller.signal.removeEventListener("abort", cancelBrowser);
          cancelBrowser();
        };
        await browserAuth.open(started.verificationUri);
        if (controller.signal.aborted) return;
      } else {
        window.open(started.verificationUri, "acompany-model-oauth", "noopener,noreferrer");
      }
      await finishSubscriptionSignIn(started.loginId, controller);
    } catch {
      if (controller.signal.aborted) return;
      const loginId = oauthLoginIdRef.current;
      oauthLoginIdRef.current = null;
      if (loginId) void rpc.models.cancelOAuth({ loginId }).catch(() => undefined);
      onErrorRef.current(t`Could not connect this provider`);
      setOauth(null);
    } finally {
      if (oauthAbortRef.current === controller) {
        releaseOAuthCapture();
        oauthCodeSubmittingRef.current = false;
      }
      finishModelOAuthAttempt(oauthAbortRef, controller, () => setOauthPending(false));
    }
  }

  useEffect(() => () => cancelOAuthAttempt(false), []);

  return {
    oauth,
    pasteCode,
    setPasteCode,
    oauthPending,
    cancelOAuthAttempt,
    startSubscriptionSignIn,
    submitOAuthCode,
  };
}
