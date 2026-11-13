import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_CLI_PROVIDER_ID,
  GEMINI_CLI_PROVIDER_ID,
  setLocalCliRunnerForTests,
} from "@acompany/adapters";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const tempDirs: string[] = [];

afterEach(() => {
  setLocalCliRunnerForTests(undefined);
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("zero-docker embedded PGlite + local CLI end-to-end", () => {
  it("boots createApp on DATABASE_URL=pglite, signs up, connects claude-cli keyless, and runs a bot turn", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "acompany-e2e-lite-"));
    tempDirs.push(dataDir);

    setLocalCliRunnerForTests(async ({ binary, args, stdin }) => {
      expect(binary).toContain("claude");
      expect(args).toContain("sonnet");
      expect(stdin).toContain("Say hello from zero-docker mode");
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          result: "Hello from embedded PGlite + Claude CLI!",
          usage: { input_tokens: 18, output_tokens: 9 },
        }),
      };
    });

    const handle = await createApp({
      nodeEnv: "development",
      databaseUrl: "pglite",
      realtimeDatabaseUrl: "pglite",
      dataDir,
      authSecret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      encryptionKey: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      screenProxySecret: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      sandboxProvider: "desktop",
      agentRuntime: "pi",
      authUrl: "http://127.0.0.1:5173",
      webOrigin: "http://127.0.0.1:5173",
      apiUrl: "http://127.0.0.1:3100",
      apiHost: "127.0.0.1",
      emailEmulator: true,
    });

    try {
      const healthRes = await handle.app.request("http://127.0.0.1:3100/health");
      expect(healthRes.status).toBe(200);
      const health = (await healthRes.json()) as { ok: boolean; jobs: string };
      expect(health.ok).toBe(true);
      expect(health.jobs).toBe("memory");

      const signUpRes = await handle.app.request("http://127.0.0.1:3100/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:5173",
        },
        body: JSON.stringify({
          email: "owner@example.com",
          password: "Password1234!",
          name: "Local Owner",
        }),
      });
      expect(signUpRes.status).toBe(200);
      const rawCookies = signUpRes.headers.getSetCookie();
      const cookieHeader = rawCookies.map((c) => c.split(";")[0]).join("; ");
      expect(cookieHeader).toContain("better-auth");

      const callRpc = async <T>(
        procedure: string,
        input: Record<string, unknown> = {},
      ): Promise<T> => {
        const res = await handle.app.request(`http://127.0.0.1:3100/rpc/${procedure}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://127.0.0.1:5173",
            Cookie: cookieHeader,
          },
          body: JSON.stringify({ json: input }),
        });
        const text = await res.text();
        expect(res.status, `RPC ${procedure} failed: ${text}`).toBe(200);
        const parsed = JSON.parse(text) as { json?: T };
        return (parsed.json ?? parsed) as T;
      };

      // Keyless connect to Claude Code CLI
      const cred = await callRpc<{ id: string; provider: string }>("models/connect", {
        provider: CLAUDE_CLI_PROVIDER_ID,
        modelId: "sonnet",
        label: "Claude Code CLI (Local)",
        setDefault: true,
      });
      expect(cred.provider).toBe(CLAUDE_CLI_PROVIDER_ID);

      // Create a bot and send a message
      const bot = await callRpc<{ id: string; name: string }>("bots/create", {
        name: "Builder",
        title: "Engineer",
        description: "Builds features",
        instructions: "Reply concisely.",
        computerMode: "team",
      });
      expect(bot.name).toBe("Builder");

      await callRpc("threads/send", {
        botId: bot.id,
        text: "Say hello from zero-docker mode",
      });

      // Poll messages until the in-memory worker finishes the turn
      let assistantReply = "";
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const page = await callRpc<{
          messages: Array<{ role: string; blocks: Array<{ kind: string; text?: string }> }>;
        }>("threads/messages", { botId: bot.id });
        for (const m of page.messages) {
          if (m.role !== "bot") continue;
          const text = m.blocks.map((b) => (b.kind === "text" && b.text ? b.text : "")).join("");
          if (text.includes("Hello from embedded PGlite")) {
            assistantReply = text;
            break;
          }
        }
        if (assistantReply) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      if (!assistantReply) {
        const runs = await handle.prisma.run.findMany();
        const msgs = await handle.prisma.message.findMany();
        throw new Error(
          `No assistant reply. Runs: ${JSON.stringify(runs)} | Msgs: ${JSON.stringify(msgs)}`,
        );
      }
      expect(assistantReply).toContain("Hello from embedded PGlite + Claude CLI!");
    } finally {
      await handle.stop();
    }
  }, 60_000);

  it("supports Starter Teams, Blueprints, Workspace Snapshots, Gemini CLI, Widgets, Webhooks, and Spend Caps", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "acompany-e2e-suite-"));
    tempDirs.push(dataDir);

    let callCount = 0;
    setLocalCliRunnerForTests(async ({ binary, stdin }) => {
      callCount += 1;
      expect(binary).toContain("gemini");
      if (callCount === 1 && !stdin.includes("Tool result for")) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            response:
              '<acompany_tool_call>{"name":"render_widget","arguments":{"title":"KPI Mini App","html":"<div>Live KPI: 42</div>","height":240}}</acompany_tool_call>',
            stats: { models: { "gemini-2.5-pro": { tokens: { prompt: 600, candidates: 500 } } } },
          }),
        };
      }
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          response: "Widget rendered and webhook handled!",
          stats: { models: { "gemini-2.5-pro": { tokens: { prompt: 200, candidates: 100 } } } },
        }),
      };
    });

    const handle = await createApp({
      nodeEnv: "development",
      databaseUrl: "pglite",
      realtimeDatabaseUrl: "pglite",
      dataDir,
      authSecret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      encryptionKey: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      screenProxySecret: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      sandboxProvider: "desktop",
      agentRuntime: "pi",
      authUrl: "http://127.0.0.1:5173",
      webOrigin: "http://127.0.0.1:5173",
      apiUrl: "http://127.0.0.1:3100",
      apiHost: "127.0.0.1",
      emailEmulator: true,
    });

    try {
      const signUpRes = await handle.app.request("http://127.0.0.1:3100/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:5173",
        },
        body: JSON.stringify({
          email: "team@example.com",
          password: "Password1234!",
          name: "Team Owner",
        }),
      });
      expect(signUpRes.status).toBe(200);
      const cookieHeader = signUpRes.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");

      const callRpc = async <T>(
        procedure: string,
        input: Record<string, unknown> = {},
      ): Promise<T> => {
        const res = await handle.app.request(`http://127.0.0.1:3100/rpc/${procedure}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://127.0.0.1:5173",
            Cookie: cookieHeader,
          },
          body: JSON.stringify({ json: input }),
        });
        const text = await res.text();
        expect(res.status, `RPC ${procedure} failed: ${text}`).toBe(200);
        const parsed = JSON.parse(text) as { json?: T };
        return (parsed.json ?? parsed) as T;
      };

      // 1. Connect Gemini CLI keyless
      const cred = await callRpc<{ id: string; provider: string }>("models/connect", {
        provider: GEMINI_CLI_PROVIDER_ID,
        modelId: "gemini-2.5-pro",
        label: "Gemini CLI",
        setDefault: true,
      });
      expect(cred.provider).toBe(GEMINI_CLI_PROVIDER_ID);

      // 2. Starter Teams + Export/Import Blueprint Markdown + Workspace Snapshot
      const starters =
        await callRpc<Array<{ slug: string; botCount: number }>>("blueprints/listStarters");
      expect(starters.length).toBeGreaterThanOrEqual(3);

      const applied = await callRpc<{ createdBots: number; botIds: string[] }>(
        "blueprints/applyStarter",
        { slug: "research-content" },
      );
      expect(applied.createdBots).toBe(2);
      const targetBotId = applied.botIds[0]!;

      const exportedMd = await callRpc<{ filename: string; markdown: string }>(
        "blueprints/exportMarkdown",
      );
      expect(exportedMd.markdown).toContain("Scout");

      const snapshot = await callRpc<{
        version: 1;
        spaceName: string;
        blueprintMarkdown: string;
        skills: unknown[];
        bots: Array<{ name: string }>;
      }>("export/workspaceSnapshot");
      expect(snapshot.bots.length).toBe(2);

      // 3. Inbound Webhook triggers bot -> renders interactive widget block
      const rotated = await callRpc<{ secret: string }>("bots/rotateWebhookSecret", {
        botId: targetBotId,
      });
      expect(rotated.secret.length).toBeGreaterThan(20);

      const hookRes = await handle.app.request(
        `http://127.0.0.1:3100/api/v1/bots/${targetBotId}/webhook`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${rotated.secret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ event: "build.succeeded", commit: "abc1234" }),
        },
      );
      expect(hookRes.status).toBe(200);

      let sawWidget = false;
      let sawReply = false;
      for (let i = 0; i < 40; i += 1) {
        const page = await callRpc<{
          messages: Array<{
            role: string;
            blocks: Array<{ kind: string; title?: string; text?: string }>;
          }>;
        }>("threads/messages", { botId: targetBotId });
        for (const m of page.messages) {
          for (const b of m.blocks) {
            if (b.kind === "widget" && b.title === "KPI Mini App") sawWidget = true;
            if (b.kind === "text" && b.text?.includes("Widget rendered and webhook handled!")) {
              sawReply = true;
            }
          }
        }
        if (sawWidget && sawReply) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(sawWidget).toBe(true);
      expect(sawReply).toBe(true);

      // 4. Usage breakdown & Spend Cap enforcement
      const budgetBefore = await callRpc<{
        todayTokens: number;
        byBot: Array<{ runs: number }>;
        byModel: Array<{ provider: string }>;
      }>("usage/budget");
      expect(budgetBefore.todayTokens).toBe(1400);
      expect(budgetBefore.byModel[0]?.provider).toBe(GEMINI_CLI_PROVIDER_ID);

      // Set daily cap to 1,000 tokens (already at 1,400 -> next turn must halt immediately)
      await callRpc("usage/updateBudget", {
        dailyTokenCap: 1000,
        monthlyTokenCap: null,
      });

      const callsBeforeCap = callCount;
      await callRpc("threads/send", {
        botId: targetBotId,
        text: "Should be blocked by spend cap",
      });

      let capRunError = "";
      for (let i = 0; i < 30; i += 1) {
        const runs = await handle.prisma.run.findMany({
          where: { botId: targetBotId, status: "failed" },
        });
        if (runs[0]?.error) {
          capRunError = runs[0].error;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(capRunError).toContain("Daily token spend cap reached");
      expect(callCount).toBe(callsBeforeCap);
    } finally {
      await handle.stop();
    }
  }, 60_000);
});
