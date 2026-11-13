import { PiOAuthLogins } from "@acompany/adapters";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountModelOAuthCallback } from "./model-oauth-callback.js";

const actor = { userId: "callback-test-user", spaceId: "callback-test-space" };
const state = "callback-test-state";
const code = "callback-test-code";

async function fixture() {
  const logins = new PiOAuthLogins(async (_provider, _type, interaction) => {
    const authorization = new URL("https://claude.ai/oauth/authorize");
    authorization.search = new URLSearchParams({
      state,
      redirect_uri: "http://localhost:53692/callback",
    }).toString();
    interaction.notify({ type: "auth_url", url: authorization.toString() });
    await interaction.prompt({ type: "manual_code", message: "fallback" });
    return {
      type: "oauth",
      access: "test-access",
      refresh: "test-refresh",
      expires: Date.now() + 3600000,
    };
  });
  const app = new Hono();
  mountModelOAuthCallback(app, logins);
  const started = await logins.begin({ ...actor, provider: "anthropic" });
  return { app, logins, started };
}

describe("Claude loopback callback route", () => {
  it("automatically hands a valid callback to its pending login without rendering secrets", async () => {
    const { app, logins, started } = await fixture();
    try {
      const response = await app.request(
        `http://localhost:53692/callback?code=${code}&state=${state}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      const body = await response.text();
      expect(body).toContain("A-Company");
      expect(body).not.toContain(code);
      expect(body).not.toContain(state);
      await vi.waitFor(() =>
        expect(logins.complete(started.loginId, actor).status).toBe("connected"),
      );
    } finally {
      logins.abortAll();
    }
  });

  it("rejects wrong origins and malformed or repeated query parameters without consuming the login", async () => {
    const { app, logins, started } = await fixture();
    try {
      for (const target of [
        `http://remote.example:53692/callback?code=${code}&state=${state}`,
        `http://localhost:3100/callback?code=${code}&state=${state}`,
        `http://localhost:53692/callback?code=${code}`,
        `http://localhost:53692/callback?code=${code}&state=unknown`,
        `http://localhost:53692/callback?code=${code}&state=${state}&state=extra`,
        `http://localhost:53692/callback?code=${code}&code=extra&state=${state}`,
        `http://localhost:53692/callback?code=${code}&error=denied&state=${state}`,
      ]) {
        const response = await app.request(target);
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(await response.text()).not.toContain(code);
        expect(logins.complete(started.loginId, actor).status).toBe("pending");
      }
    } finally {
      logins.abortAll();
    }
  });
});
