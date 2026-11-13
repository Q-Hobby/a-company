import { expect, test } from "@playwright/test";
import { startLocalImportServer } from "../../../packages/adapters/src/local-import/server";
import { captureScreenshot, openUserSettings } from "./helpers";

const stamp = "2026-01-01T00:00:00.000Z";

test("real helper accepts browser form approval and pairs without exposing source data", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  await page.context().grantPermissions(["local-network-access"], { origin });
  let scans = 0;
  const helper = await startLocalImportServer({
    port: 0,
    allowedOrigins: [origin],
    collector: {
      scan: async () => {
        scans++;
        return { projects: [], sessions: [], skills: [], sources: [], warnings: [] };
      },
      bundle: async () => {
        throw new Error("Unexpected bundle request");
      },
    },
  });
  try {
    const address = helper.address();
    if (!address || typeof address === "string") throw new Error("Helper not listening");
    const helperOrigin = `http://127.0.0.1:${address.port}`;
    const connect = `${helperOrigin}/connect?origin=${encodeURIComponent(origin)}`;
    await page.route("**/local-import-approval-fixture", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><button id="connect">Connect</button><script>
      let popup;
      document.querySelector('#connect').onclick = () => { popup = window.open(${JSON.stringify(connect)}); };
      window.addEventListener('message', async event => {
        if(event.origin !== ${JSON.stringify(helperOrigin)} || event.source !== popup || event.data.type !== 'a-company-import-connected') return;
        const response = await fetch(${JSON.stringify(`${helperOrigin}/scan`)}, {headers: {Authorization: 'Bearer ' + event.data.capability}});
        window.approvalFixtureConnected = response.ok;
      });
      </script>`,
      }),
    );
    await page.goto(`${origin}/local-import-approval-fixture`);
    const opened = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const popup = await opened;
    expect(scans).toBe(0);
    const approval = popup.waitForResponse(
      (response) => new URL(response.url()).pathname === "/approve",
    );
    await popup.getByRole("button", { name: "Allow", exact: true }).click();
    expect((await approval).status()).toBe(200);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { approvalFixtureConnected?: boolean }).approvalFixtureConnected,
        ),
      )
      .toBe(true);
    expect(scans).toBe(1);
  } finally {
    await new Promise<void>((resolve) => {
      helper.close(() => resolve());
      helper.closeAllConnections();
    });
  }
});
const bot = {
  id: "fixture-bot",
  spaceId: "fixture-space",
  name: "Demo agent",
  title: "",
  description: "",
  instructions: "",
  color: "",
  notifyOnFinish: false,
  pinned: false,
  sectionId: null,
  archivedAt: null,
  unread: false,
  parentBotId: null,
  memoryScope: null,
  threadId: "fixture-thread",
  preview: "",
  status: "idle",
  computerMode: "team",
  updatedAt: stamp,
  createdAt: stamp,
  voiceId: null,
  autoSpeak: false,
  modelProvider: null,
  modelCredentialId: null,
  modelId: null,
  thinkingLevel: null,
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  webhookConfigured: false,
  spawnKey: null,
};
const me = {
  userId: "fixture-owner",
  email: "fixture@example.test",
  name: "Demo workspace",
  spaceId: "fixture-space",
  isDeploymentOwner: false,
  needsModel: false,
  defaultProvider: null,
  defaultModel: null,
  computerHost: null,
  canChooseHostComputer: false,
  sandboxProvider: "none",
  avatarStyle: "robot",
};
const thread = {
  threadId: bot.threadId,
  botId: bot.id,
  cursor: -1,
  messages: [],
  olderCursor: null,
  run: null,
  activeRuns: [],
};
const preview = {
  projects: [{ id: "project-1", name: "Sample project", source: "hermes", fileCount: 1 }],
  sessions: [{ id: "session-1", title: "Sample conversation", source: "codex", messageCount: 2 }],
  skills: [
    {
      id: "skill-1",
      name: "Research notes",
      source: "hermes",
      description: "Read-only skill",
      fileCount: 1,
    },
  ],
  sensitiveSources: [{ id: "auth-1", source: "hermes", name: "Hermes credentials", fileCount: 2 }],
  warnings: ["RUNTIME_NOT_IMPORTED", "SKILLS_ARCHIVED_INACTIVE"],
};
const packet = { encoding: "gzip-base64", data: "fixture-packet" };
const receipt = {
  id: "a".repeat(64),
  importedAt: stamp,
  projectCount: 0,
  sessionCount: 1,
  skillCount: 0,
  warnings: [],
};

test("portable import requires selection, upload consent and confirmation; archive is inert", async ({
  page,
  context,
}, testInfo) => {
  let committed = false;
  let previews = 0;
  let commits = 0;
  let bundleSelections: unknown;
  let importedReceipt = receipt;
  const exportRequests: unknown[] = [];
  await page.addInitScript(() => {
    localStorage.setItem("acompany.uiLocale", "en");
  });
  await page.route("**/api/auth/get-session**", (route) =>
    route.fulfill({
      json: {
        session: {
          id: "fixture-session",
          userId: me.userId,
          token: "fixture-token",
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          createdAt: stamp,
          updatedAt: stamp,
        },
        user: {
          id: me.userId,
          email: me.email,
          name: me.name,
          emailVerified: true,
          createdAt: stamp,
          updatedAt: stamp,
        },
      },
    }),
  );
  await context.route("http://127.0.0.1:43123/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/connect") {
      const origin = url.searchParams.get("origin");
      await route.fulfill({
        contentType: "text/html",
        body: `<button id="approve">Approve local access</button><script>document.querySelector('button').onclick=()=>opener.postMessage({type:'a-company-import-connected',capability:'${"b".repeat(64)}'},${JSON.stringify(origin)})</script>`,
      });
      return;
    }
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    expect(request.headers().authorization).toBe(`Bearer ${"b".repeat(64)}`);
    if (url.pathname === "/bundle") bundleSelections = request.postDataJSON();
    await route.fulfill({
      headers,
      json:
        url.pathname === "/scan"
          ? {
              ...preview,
              projects: preview.projects.map((item) => ({ ...item, fileCount: null })),
              skills: preview.skills.map((item) => ({ ...item, fileCount: null })),
              sources: [],
            }
          : packet,
    });
  });
  await page.route("**/rpc/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/rpc\//, "");
    let value: unknown = [];
    if (path === "bootstrap")
      value = {
        me,
        bots: [bot],
        groups: [],
        botSections: [],
        archivedBots: [],
        archivedGroups: [],
        thread,
        routines: [],
        spaces: [],
      };
    else if (path === "me") value = me;
    else if (path === "bots/list") value = [bot];
    else if (path === "threads/get") value = thread;
    else if (path === "threads/head") value = { cursor: -1 };
    else if (path === "threads/subscribe") {
      await route.abort();
      return;
    } else if (path === "memory/providerConfig") value = null;
    else if (path === "voice/status") value = { available: false };
    else if (path === "messaging/status") value = { enabled: false };
    else if (path === "imports/list") value = committed ? [importedReceipt] : [];
    else if (path === "imports/preview") {
      previews++;
      value = preview;
    } else if (path === "imports/commit") {
      commits++;
      committed = true;
      const selection = route.request().postDataJSON().json.selection;
      expect(selection).toEqual({
        projectIds: [],
        sessionIds: ["session-1"],
        skillIds: [],
        includeSensitiveData: commits > 1,
        sensitiveSourceIds: [],
      });
      importedReceipt = {
        ...receipt,
        ...(selection.includeSensitiveData
          ? { includeSensitiveData: true, sensitiveFileCount: 2 }
          : {}),
      };
      value = importedReceipt;
    } else if (path === "imports/get")
      value = {
        receipt,
        bundle: {
          version: 1,
          exportedAt: stamp,
          projects: [],
          sessions: [
            {
              id: "session-1",
              source: "codex",
              title: "Sample conversation",
              messages: [
                {
                  id: "m1",
                  role: "user",
                  content: "<script>window.importExecuted = true</script>",
                },
                { id: "m2", role: "assistant", content: "Imported history stays here." },
              ],
            },
          ],
          skills: [],
          warnings: [],
        },
      };
    else if (path === "imports/export") {
      exportRequests.push(route.request().postDataJSON().json);
      value = { packet };
    }
    await route.fulfill({ json: { json: value } });
  });
  await page.goto("/app/fixture-bot");
  const settings = await openUserSettings(page);
  await settings.getByTestId("settings-nav-imports").click();
  const popupReady = page.waitForEvent("popup");
  await settings.getByRole("button", { name: "Connect local", exact: true }).click();
  const popup = await popupReady;
  await popup.getByRole("button", { name: "Approve local access" }).click();
  await expect(
    settings.getByRole("checkbox", { name: "Include sensitive data", exact: true }),
  ).not.toBeChecked();
  await expect(settings.getByRole("checkbox", { name: "Hermes credentials" })).toHaveCount(0);
  await expect(settings.getByRole("checkbox", { name: "Sample conversation" })).not.toBeChecked();
  await expect(settings.getByRole("button", { name: "Prepare selection" })).toBeDisabled();
  await captureScreenshot(page, testInfo, "portable-import-selection");
  await settings.getByRole("checkbox", { name: "Sample conversation" }).check();
  await settings.getByRole("button", { name: "Prepare selection" }).click();
  await expect(settings.getByRole("button", { name: "Upload for preview" })).toBeVisible();
  expect(previews).toBe(0);
  expect(bundleSelections).toEqual({
    selection: {
      projectIds: [],
      sessionIds: ["session-1"],
      skillIds: [],
      includeSensitiveData: false,
      sensitiveSourceIds: [],
    },
  });
  await settings.getByRole("button", { name: "Upload for preview" }).click();
  await expect(settings.getByRole("button", { name: "Confirm import" })).toBeEnabled();
  expect(commits).toBe(0);
  await settings.getByText("Warnings and omissions", { exact: true }).click();
  await expect(settings.getByRole("button", { name: "Confirm import" })).toBeInViewport({
    ratio: 1,
  });
  await captureScreenshot(page, testInfo, "portable-import-preview");
  await settings.getByRole("button", { name: "Confirm import" }).click();
  await expect(settings.getByText("Import complete", { exact: true })).toBeVisible();
  expect(commits).toBe(1);
  await settings.getByRole("button", { name: "Inspect", exact: true }).click();
  await settings.getByText("Sample conversation", { exact: true }).click();
  await expect(settings.locator("pre").first()).toContainText("<script>");
  expect(await page.evaluate(() => "importExecuted" in window)).toBe(false);
  await captureScreenshot(page, testInfo, "portable-import-archive");
  const downloaded = page.waitForEvent("download");
  await settings.getByRole("button", { name: "Download", exact: true }).click();
  expect((await downloaded).suggestedFilename()).toMatch(/\.a-company-import\.json$/);
  expect(exportRequests).toEqual([{ id: receipt.id, includeSensitiveData: false }]);

  await settings.locator('input[type="file"]').setInputFiles({
    name: "sensitive.a-company-import.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ ...packet, includeSensitiveData: true })),
  });
  await expect(
    settings.getByRole("checkbox", { name: "Include sensitive data", exact: true }),
  ).not.toBeChecked();
  await expect(settings.getByRole("button", { name: "Upload for preview" })).toBeDisabled();
  expect(previews).toBe(1);
  await settings.getByRole("checkbox", { name: "Include sensitive data", exact: true }).check();
  await expect(settings.getByText(/Selected data may contain passwords/)).toBeVisible();
  await settings.getByRole("button", { name: "Upload for preview" }).click();
  await settings.getByRole("checkbox", { name: "Include sensitive data", exact: true }).uncheck();
  await expect(settings.getByRole("button", { name: "Confirm import" })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Upload for preview" })).toBeDisabled();
  await settings.getByRole("checkbox", { name: "Include sensitive data", exact: true }).check();
  await settings.getByRole("button", { name: "Upload for preview" }).click();
  await settings.getByRole("checkbox", { name: "Sample conversation" }).check();
  await settings.getByRole("button", { name: "Confirm import" }).click();
  await expect(settings.getByText("2 sensitive files included", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Export sensitive data", exact: true }).click();
  await expect(settings.getByRole("alertdialog")).toContainText("contains secrets");
  expect(exportRequests).toHaveLength(1);
  await settings.getByRole("button", { name: "Cancel export", exact: true }).click();
  expect(exportRequests).toHaveLength(1);
  await settings.getByRole("button", { name: "Export sensitive data", exact: true }).click();
  const sensitiveDownload = page.waitForEvent("download");
  await settings.getByRole("button", { name: "Yes, export sensitive data", exact: true }).click();
  await sensitiveDownload;
  expect(exportRequests[1]).toEqual({ id: receipt.id, includeSensitiveData: true });
});
