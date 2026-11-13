import { randomBytes } from "node:crypto";
import type { PiOAuthLogins } from "@acompany/adapters";
import { ANTHROPIC_OAUTH_REDIRECT_URI } from "@acompany/adapters";
import type { Hono } from "hono";

/** Only the pending login's unpredictable OAuth state authorizes this public callback. */
export function mountModelOAuthCallback(
  app: Hono,
  logins: Pick<PiOAuthLogins, "acceptAnthropicCallback">,
) {
  const redirect = new URL(ANTHROPIC_OAUTH_REDIRECT_URI);
  app.get(redirect.pathname, (c) => {
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    c.header("x-content-type-options", "nosniff");
    c.header(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    const callback = new URL(c.req.url);
    if (
      callback.protocol !== redirect.protocol ||
      callback.port !== redirect.port ||
      !["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname)
    ) {
      return c.text("A-Company", 403);
    }
    const params = callback.searchParams;
    if (
      callback.search.length > 8192 ||
      params.getAll("state").length !== 1 ||
      params.getAll("code").length + params.getAll("error").length !== 1 ||
      !logins.acceptAnthropicCallback({
        state: params.get("state") ?? "",
        code: params.get("code") ?? undefined,
        error: params.get("error") ?? undefined,
      })
    ) {
      return c.text("A-Company", 400);
    }
    const nonce = randomBytes(16).toString("base64");
    c.header(
      "content-security-policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    );
    // Never render the authorization code/state or send them to an opener window.
    // The original app polls the backend and owns credential persistence.
    return c.html(
      `<!doctype html><html><head><meta charset="utf-8"><title>A-Company</title></head><body>A-Company<script nonce="${nonce}">history.replaceState(null,"","/callback");window.close();</script></body></html>`,
    );
  });
}
