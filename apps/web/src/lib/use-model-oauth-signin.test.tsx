// @vitest-environment jsdom

import type { ACompanyDesktopOAuthCallback } from "@acompany/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  beginOAuth: vi.fn(),
  completeOAuth: vi.fn(),
  finishOAuth: vi.fn(),
  submitOAuthCode: vi.fn(),
  cancelOAuth: vi.fn(),
}));
vi.mock("./rpc", () => ({ rpc: { models: api } }));
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));

import { useModelOAuthSignIn } from "./use-model-oauth-signin";

const started = {
  mode: "auth-url" as const,
  loginId: "login-fixture",
  verificationUri: "https://provider.example/authorize?state=fixture-state",
};
let hook!: ReturnType<typeof useModelOAuthSignIn>;
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
const onFinished = vi.fn();
const onError = vi.fn();

beforeEach(async () => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "open").mockImplementation(() => null);
  api.beginOAuth.mockResolvedValue(started);
  api.completeOAuth.mockResolvedValue({ status: "pending" });
  api.finishOAuth.mockResolvedValue({});
  api.submitOAuthCode.mockResolvedValue({});
  api.cancelOAuth.mockResolvedValue({});
  container = document.createElement("div");
  root = createRoot(container);
  function Harness() {
    hook = useModelOAuthSignIn({ onFinished, onError });
    return null;
  }
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  delete window.acompanyDesktop;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function start() {
  let completion!: Promise<void>;
  await act(async () => {
    completion = hook.startSubscriptionSignIn({ provider: "anthropic" });
  });
  return { completion };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function desktop() {
  const callbacks: ((value: ACompanyDesktopOAuthCallback) => void)[] = [];
  const releases: ReturnType<typeof vi.fn>[] = [];
  const oauth = {
    open: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    onCallback: vi.fn((callback: (value: ACompanyDesktopOAuthCallback) => void) => {
      callbacks.push(callback);
      const release = vi.fn();
      releases.push(release);
      return release;
    }),
  };
  Object.defineProperty(window, "acompanyDesktop", {
    value: { oauth },
    configurable: true,
    writable: true,
  });
  return { oauth, callbacks, releases };
}

it("automatically polls auth-url sign-in and finishes without manual code submission", async () => {
  const { completion } = await start();
  expect(api.completeOAuth).toHaveBeenCalledOnce();
  expect(hook.oauthPending).toBe(true);
  api.completeOAuth.mockResolvedValue({ status: "ready" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
    await completion;
  });
  expect(api.submitOAuthCode).not.toHaveBeenCalled();
  expect(api.finishOAuth).toHaveBeenCalledExactlyOnceWith(
    { loginId: started.loginId },
    { signal: expect.any(AbortSignal) },
  );
  expect(onFinished).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
  expect(hook.oauth).toBeNull();
  expect(hook.oauthPending).toBe(false);
});

it("submits the manual fallback once while the original poll owns completion", async () => {
  const { completion } = await start();
  await act(async () => hook.setPasteCode("fixture-code#fixture-state"));
  let submitted!: Promise<void>;
  await act(async () => {
    submitted = hook.submitOAuthCode();
    void hook.submitOAuthCode();
  });
  expect(api.submitOAuthCode).toHaveBeenCalledOnce();
  expect(api.completeOAuth).toHaveBeenCalledOnce();
  expect(hook.oauthPending).toBe(true);
  api.completeOAuth.mockResolvedValue({ status: "ready" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([submitted, completion]);
  });
  expect(api.finishOAuth).toHaveBeenCalledOnce();
  expect(onFinished).toHaveBeenCalledOnce();
});

it("keeps polling after a rejected manual fallback without exposing callback codes in errors", async () => {
  const { completion } = await start();
  api.submitOAuthCode.mockRejectedValueOnce(
    new Error("Rejected fixture-private-code#fixture-state"),
  );
  await act(async () => hook.setPasteCode("fixture-private-code#fixture-state"));
  await act(async () => hook.submitOAuthCode());
  expect(onError).toHaveBeenCalledExactlyOnceWith("Could not connect this provider");
  expect(hook.oauthPending).toBe(true);
  await act(async () => hook.submitOAuthCode());
  expect(api.submitOAuthCode).toHaveBeenCalledTimes(2);
  api.completeOAuth.mockResolvedValue({ status: "ready" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
    await completion;
  });
  expect(api.finishOAuth).toHaveBeenCalledOnce();
  expect(onFinished).toHaveBeenCalledOnce();
});

it("ignores a late fallback rejection after automatic completion", async () => {
  const submitting = deferred<object>();
  api.submitOAuthCode.mockReturnValueOnce(submitting.promise);
  const { completion } = await start();
  let submission!: Promise<void>;
  await act(async () => {
    submission = hook.submitOAuthCode("fixture-code#fixture-state");
  });
  api.completeOAuth.mockResolvedValue({ status: "ready" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
    await completion;
    submitting.reject(new Error("Callback already consumed"));
    await submission;
  });
  expect(onError).not.toHaveBeenCalled();
  expect(hook.pasteCode).toBe("");
  expect(onFinished).toHaveBeenCalledOnce();
});

it.each(["cancel", "unmount"])("aborts a pending completion request on %s", async (action) => {
  const completing = deferred<{ status: "ready" }>();
  api.completeOAuth.mockReturnValueOnce(completing.promise);
  const { completion } = await start();
  const signal = api.completeOAuth.mock.calls[0]![1].signal as AbortSignal;
  await act(async () => {
    if (action === "cancel") hook.cancelOAuthAttempt();
    else root.unmount();
    completing.resolve({ status: "ready" });
    await completion;
  });
  expect(signal.aborted).toBe(true);
  expect(api.finishOAuth).not.toHaveBeenCalled();
  expect(onFinished).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  expect(api.cancelOAuth).toHaveBeenCalledExactlyOnceWith({ loginId: started.loginId });
  expect(vi.getTimerCount()).toBe(0);
});

it("does not refresh a cancelled attempt after an in-flight persistence request returns", async () => {
  const persisted = deferred<object>();
  api.completeOAuth.mockResolvedValue({ status: "ready" });
  api.finishOAuth.mockReturnValueOnce(persisted.promise);
  const { completion } = await start();
  expect(api.finishOAuth).toHaveBeenCalledOnce();
  await act(async () => {
    hook.cancelOAuthAttempt();
    persisted.resolve({});
    await completion;
  });
  expect(onFinished).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  expect(hook.oauthPending).toBe(false);
});

it("keeps the retry submitting guard when a cancelled submission rejects late", async () => {
  const bridge = desktop();
  const submitting = deferred<object>();
  api.submitOAuthCode.mockReturnValueOnce(submitting.promise);
  const old = await start();
  let oldSubmission!: Promise<void>;
  await act(async () => {
    oldSubmission = hook.submitOAuthCode("old-code#fixture-state");
    hook.cancelOAuthAttempt();
  });
  api.beginOAuth.mockResolvedValue({ ...started, loginId: "retry-fixture" });
  const retry = await start();
  await act(async () => {
    bridge.callbacks[1]!({ code: "retry-code", state: "fixture-state" });
    submitting.reject(new Error("Old attempt failed"));
    await oldSubmission;
    bridge.callbacks[1]!({ code: "duplicate-code", state: "fixture-state" });
  });
  expect(api.submitOAuthCode).toHaveBeenCalledTimes(2);
  expect(bridge.releases[1]).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  api.completeOAuth.mockResolvedValue({ status: "ready" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([old.completion, retry.completion]);
  });
  expect(api.finishOAuth).toHaveBeenCalledOnce();
  expect(onFinished).toHaveBeenCalledOnce();
});

it.each(["beginOAuth", "completeOAuth", "finishOAuth"] as const)(
  "does not expose callback details from %s errors",
  async (method) => {
    api.completeOAuth.mockResolvedValue({ status: "ready" });
    api[method].mockRejectedValueOnce(new Error("Provider rejected fixture-private-code"));
    const { completion } = await start();
    await act(async () => completion);
    expect(onError).toHaveBeenCalledExactlyOnceWith("Could not connect this provider");
    expect(onFinished).not.toHaveBeenCalled();
    expect(hook.oauthPending).toBe(false);
    expect(hook.oauth).toBeNull();
  },
);

it("cancels a login returned after cancellation without disturbing a newer attempt", async () => {
  const beginning = deferred<typeof started>();
  api.beginOAuth.mockReturnValueOnce(beginning.promise);
  const old = await start();
  api.beginOAuth.mockResolvedValue({ ...started, loginId: "retry-fixture" });
  const retry = await start();
  await act(async () => {
    beginning.resolve(started);
    await old.completion;
  });
  expect(api.cancelOAuth).toHaveBeenCalledWith({ loginId: started.loginId });
  expect(hook.oauth?.loginId).toBe("retry-fixture");
  expect(hook.oauthPending).toBe(true);
  api.completeOAuth.mockResolvedValue({ status: "ready" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
    await retry.completion;
  });
  expect(onFinished).toHaveBeenCalledOnce();
});

it("captures desktop callbacks before open and keeps the listener until persistence finishes", async () => {
  const bridge = desktop();
  const persisted = deferred<object>();
  api.finishOAuth.mockReturnValue(persisted.promise);
  bridge.oauth.open.mockImplementation(async () => {
    bridge.callbacks[0]!({ code: "fixture-code", state: "fixture-state" });
  });
  const { completion } = await start();
  expect(api.submitOAuthCode).toHaveBeenCalledExactlyOnceWith(
    { loginId: started.loginId, code: "fixture-code#fixture-state" },
    { signal: expect.any(AbortSignal) },
  );
  expect(bridge.releases[0]).not.toHaveBeenCalled();
  api.completeOAuth.mockResolvedValue({ status: "ready" });
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(api.finishOAuth).toHaveBeenCalledOnce();
  expect(bridge.releases[0]).not.toHaveBeenCalled();
  await act(async () => {
    persisted.resolve({});
    await completion;
  });
  expect(bridge.releases[0]).toHaveBeenCalledOnce();
  expect(onFinished).toHaveBeenCalledOnce();
});

it("replaces an in-flight attempt without letting its queued desktop callback submit to the retry", async () => {
  const bridge = desktop();
  const old = await start();
  const oldSignal = api.completeOAuth.mock.calls[0]![1].signal as AbortSignal;
  api.beginOAuth.mockResolvedValue({ ...started, loginId: "retry-fixture" });
  const retry = await start();
  expect(oldSignal.aborted).toBe(true);
  expect(bridge.releases[0]).toHaveBeenCalledOnce();
  await act(async () => {
    bridge.callbacks[0]!({ code: "stale-code", state: "fixture-state" });
    bridge.callbacks[1]!({ code: "retry-code", state: "fixture-state" });
  });
  expect(api.submitOAuthCode).toHaveBeenCalledExactlyOnceWith(
    { loginId: "retry-fixture", code: "retry-code#fixture-state" },
    { signal: expect.any(AbortSignal) },
  );
  api.completeOAuth.mockResolvedValue({ status: "ready" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([old.completion, retry.completion]);
  });
  expect(api.finishOAuth).toHaveBeenCalledOnce();
  expect(onFinished).toHaveBeenCalledOnce();
});
