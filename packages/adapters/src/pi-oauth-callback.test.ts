import { describe, expect, it, vi } from "vitest";
import { createManualAnthropicOAuthLogin } from "./pi-anthropic-oauth.js";
import { PiOAuthLogins } from "./pi-oauth.js";

function fixture() {
  let sequence = 0;
  const exchange = vi.fn(async () =>
    Response.json({ access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600 }),
  );
  const login = createManualAnthropicOAuthLogin({
    fetch: exchange as typeof fetch,
    createVerifier: () => `test-state-${++sequence}`,
  });
  const logins = new PiOAuthLogins((_provider, _type, interaction) => login(interaction));
  return { exchange, logins };
}

const actor = { userId: "test-user", spaceId: "test-space" };

describe("automatic Claude OAuth callback", () => {
  it("rejects unknown, empty and replayed callbacks without consuming another login", async () => {
    const { logins, exchange } = fixture();
    try {
      const started = await logins.begin({ ...actor, provider: "anthropic" });
      expect(logins.acceptAnthropicCallback({ state: "unknown", code: "test-code" })).toBe(false);
      expect(logins.acceptAnthropicCallback({ state: "", code: "test-code" })).toBe(false);
      expect(
        logins.acceptAnthropicCallback({
          state: "test-state-1",
          code: "test-code",
          error: "denied",
        }),
      ).toBe(false);
      expect(logins.acceptAnthropicCallback({ state: "test-state-1", code: " " })).toBe(false);
      expect(logins.complete(started.loginId, actor).status).toBe("pending");
      expect(exchange).not.toHaveBeenCalled();
      expect(logins.acceptAnthropicCallback({ state: "test-state-1", code: "test-code" })).toBe(
        true,
      );
      expect(logins.acceptAnthropicCallback({ state: "test-state-1", code: "test-code" })).toBe(
        false,
      );
      await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
    } finally {
      logins.abortAll();
    }
  });

  it("rejects a callback from a replaced login without consuming the replacement", async () => {
    const { logins } = fixture();
    try {
      await logins.begin({ ...actor, provider: "anthropic" });
      const replacement = await logins.begin({ ...actor, provider: "anthropic" });
      expect(logins.acceptAnthropicCallback({ state: "test-state-1", code: "old-code" })).toBe(
        false,
      );
      expect(logins.complete(replacement.loginId, actor).status).toBe("pending");
      expect(logins.acceptAnthropicCallback({ state: "test-state-2", code: "new-code" })).toBe(
        true,
      );
      await vi.waitFor(() =>
        expect(logins.complete(replacement.loginId, actor).status).toBe("connected"),
      );
    } finally {
      logins.abortAll();
    }
  });

  it("keeps concurrent actors separate and rejects a cancelled login", async () => {
    const { logins, exchange } = fixture();
    try {
      const other = { userId: "other-user", spaceId: "other-space" };
      const first = await logins.begin({ ...actor, provider: "anthropic" });
      const second = await logins.begin({ ...other, provider: "anthropic" });
      await logins.cancel(first.loginId, actor);
      expect(logins.acceptAnthropicCallback({ state: "test-state-1", code: "first-code" })).toBe(
        false,
      );
      expect(logins.acceptAnthropicCallback({ state: "test-state-2", code: "second-code" })).toBe(
        true,
      );
      await vi.waitFor(() =>
        expect(logins.complete(second.loginId, other).status).toBe("connected"),
      );
      expect(logins.complete(second.loginId, actor).status).toBe("error");
      expect(exchange).toHaveBeenCalledOnce();
    } finally {
      logins.abortAll();
    }
  });

  it("surfaces authorization denial without exchanging a token or exposing provider details", async () => {
    const { logins, exchange } = fixture();
    try {
      const started = await logins.begin({ ...actor, provider: "anthropic" });
      expect(
        logins.acceptAnthropicCallback({ state: "test-state-1", error: "access_denied" }),
      ).toBe(true);
      await vi.waitFor(() => expect(logins.complete(started.loginId, actor).status).toBe("error"));
      expect(exchange).not.toHaveBeenCalled();
    } finally {
      logins.abortAll();
    }
  });

  it("completes the matching login without a manual code submission", async () => {
    const { logins, exchange } = fixture();
    try {
      const started = await logins.begin({ ...actor, provider: "anthropic" });
      const state = new URL(started.verificationUri).searchParams.get("state")!;
      expect(logins.acceptAnthropicCallback({ state, code: "test-code" })).toBe(true);
      await vi.waitFor(() =>
        expect(logins.complete(started.loginId, actor).status).toBe("connected"),
      );
      expect(exchange).toHaveBeenCalledOnce();
      const persist = vi.fn(async () => ({ connected: true }));
      expect(await logins.finish(started.loginId, actor, persist)).toEqual({
        status: "connected",
        value: { connected: true },
      });
      expect(persist).toHaveBeenCalledOnce();
    } finally {
      logins.abortAll();
    }
  });
});
