import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("standalone engine opens without login and preserves workspace data after quit", async () => {
  test.setTimeout(120_000);
  const userData = await mkdtemp(path.join(tmpdir(), "acompany-standalone-e2e-"));
  const launch = () =>
    electron.launch({
      args: ["."],
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        ACOMPANY_WEB_URL: "",
        ACOMPANY_FORCE_SETUP: "0",
        ACOMPANY_EMBEDDED_MODE: "1",
        ACOMPANY_MODEL_CATALOG_UPDATES: "off",
        ACOMPANY_PERFORMANCE_USER_DATA: userData,
      },
    });
  let app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible({
      timeout: 60_000,
    });
    expect(new URL(page.url()).hostname).toBe("127.0.0.1");
    expect(new URL(page.url()).pathname).toBe("/onboarding");
    await page.screenshot({
      path: path.join(import.meta.dirname, "screenshots/10-standalone-onboarding.png"),
    });
    const spaceId = await page.evaluate(async () => {
      const response = await fetch("/rpc/spaces/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { name: "Standalone persistence fixture" } }),
      });
      if (!response.ok) throw new Error(`Create fixture failed: ${response.status}`);
      return ((await response.json()) as { json: { id: string } }).json.id;
    });
    expect(spaceId).toBeTruthy();
    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await expect(reopened.getByRole("heading", { name: "Connect a model" })).toBeVisible({
      timeout: 60_000,
    });
    const persisted = await reopened.evaluate(async (id) => {
      const response = await fetch("/rpc/spaces/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      });
      return response.ok && JSON.stringify(await response.json()).includes(id);
    }, spaceId);
    expect(persisted).toBe(true);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});
