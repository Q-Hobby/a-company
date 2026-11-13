import { expect, test } from "@playwright/test";
import { captureScreenshot, openUserSettings } from "./helpers";

test("Claude sign-in completes automatically with manual entry hidden as a fallback", async ({
  page,
}, testInfo) => {
  let callbackReceived = false;
  let finished = 0;
  let submitted = 0;
  await page.addInitScript(() => {
    localStorage.setItem("acompany.uiLocale", "en");
    window.open = () => null;
  });
  await page.route("**/rpc/models/beginOAuth", (route) =>
    route.fulfill({
      json: {
        json: {
          mode: "auth-url",
          loginId: "test-claude-login",
          provider: "anthropic",
          verificationUri:
            "https://claude.ai/oauth/authorize?state=test-state&redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback",
          expiresInSeconds: 900,
        },
      },
    }),
  );
  await page.route("**/rpc/models/completeOAuth", (route) =>
    route.fulfill({
      json: { json: { status: callbackReceived ? "ready" : "pending" } },
    }),
  );
  await page.route("**/rpc/models/finishOAuth", (route) => {
    finished++;
    return route.fulfill({ json: { json: { connected: true } } });
  });
  await page.route("**/rpc/models/submitOAuthCode", (route) => {
    submitted++;
    return route.fulfill({ json: { json: { ok: true } } });
  });
  await page.goto("/");
  await openUserSettings(page, "models");
  await page.getByPlaceholder("Search providers").fill("anthropic");
  await page.getByRole("button", { name: /Anthropic/ }).click();
  await page.getByRole("button", { name: "Sign in with Claude Pro/Max", exact: true }).click();
  await expect(page.getByText("Waiting for sign-in…", { exact: true })).toBeVisible();
  const code = page.getByRole("textbox", { name: "Authorization code or callback URL" });
  await expect(code).toBeHidden();
  await captureScreenshot(page, testInfo, "claude-oauth-automatic-wait");
  await page.getByText("Enter code manually", { exact: true }).click();
  await expect(code).toBeVisible();
  await page.getByText("Enter code manually", { exact: true }).click();
  callbackReceived = true;
  await expect.poll(() => finished).toBe(1);
  await expect(page.getByText("Waiting for sign-in…", { exact: true })).toBeHidden();
  expect(submitted).toBe(0);
});
