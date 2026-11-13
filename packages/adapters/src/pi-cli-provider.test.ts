import { afterEach, describe, expect, it } from "vitest";
import { buildModelConnectPlaintext } from "./model-connect.js";
import {
  buildClaudeCliArgs,
  buildCliTurnPrompt,
  buildCodexCliArgs,
  CLAUDE_CLI_PROVIDER_ID,
  CODEX_CLI_PROVIDER_ID,
  extractClaudeCliJsonOutput,
  extractCodexCliJsonOutput,
  extractGeminiCliJsonOutput,
  extractOpenCodeCliJsonOutput,
  GEMINI_CLI_PROVIDER_ID,
  LOCAL_CLI_PLACEHOLDER_SECRET,
  OPENCODE_CLI_PROVIDER_ID,
  parseCliAssistantOutput,
  setLocalCliRunnerForTests,
} from "./pi-cli-provider.js";
import { listPiCatalog } from "./pi-models.js";
import { PiAgentRuntime } from "./pi-runtime.js";

afterEach(() => {
  setLocalCliRunnerForTests(undefined);
});

describe("local CLI providers (claude-cli & codex-cli)", () => {
  it("lists both local CLI providers in the model catalog and connects keyless", () => {
    const catalog = listPiCatalog();
    expect(catalog.some((e) => e.provider === CLAUDE_CLI_PROVIDER_ID && e.id === "sonnet")).toBe(
      true,
    );
    expect(catalog.some((e) => e.provider === CODEX_CLI_PROVIDER_ID && e.id === "gpt-5.4")).toBe(
      true,
    );

    expect(
      buildModelConnectPlaintext({ provider: CLAUDE_CLI_PROVIDER_ID, modelId: "sonnet" }),
    ).toBe(LOCAL_CLI_PLACEHOLDER_SECRET);
    expect(
      buildModelConnectPlaintext({ provider: CODEX_CLI_PROVIDER_ID, modelId: "gpt-5.4" }),
    ).toBe(LOCAL_CLI_PLACEHOLDER_SECRET);
    expect(
      catalog.some((e) => e.provider === GEMINI_CLI_PROVIDER_ID && e.id === "gemini-2.5-pro"),
    ).toBe(true);
    expect(catalog.some((e) => e.provider === OPENCODE_CLI_PROVIDER_ID && e.id === "default")).toBe(
      true,
    );
    expect(
      extractGeminiCliJsonOutput(
        JSON.stringify({
          response: "Gemini OK",
          stats: { models: { m: { tokens: { prompt: 12, candidates: 8 } } } },
        }),
      ),
    ).toMatchObject({ text: "Gemini OK", usage: { input: 12, output: 8 } });
    expect(
      extractOpenCodeCliJsonOutput(
        [
          JSON.stringify({ type: "text", part: { text: "OpenCode OK" } }),
          JSON.stringify({ type: "step_finish", part: { tokens: { input: 7, output: 3 } } }),
        ].join("\n"),
      ),
    ).toMatchObject({ text: "OpenCode OK", usage: { input: 7, output: 3 } });
  });

  it("parses Claude stream-json / json frames and Codex exec --json NDJSON frames", () => {
    const claudeOut = extractClaudeCliJsonOutput(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Hello from Claude Code!",
        usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 3 },
      }),
    );
    expect(claudeOut.text).toBe("Hello from Claude Code!");
    expect(claudeOut.usage.input).toBe(12);
    expect(claudeOut.usage.output).toBe(5);
    expect(claudeOut.usage.cacheRead).toBe(3);

    const codexNdjson = [
      JSON.stringify({ type: "thread.started", thread_id: "th_1" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "it_1", type: "agent_message", text: "Hello from Codex CLI!" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 20, output_tokens: 8, cached_input_tokens: 4 },
      }),
    ].join("\n");
    const codexOut = extractCodexCliJsonOutput(codexNdjson);
    expect(codexOut.text).toBe("Hello from Codex CLI!");
    expect(codexOut.usage.input).toBe(20);
    expect(codexOut.usage.output).toBe(8);
    expect(codexOut.usage.cacheRead).toBe(4);
  });

  it("builds isolated CLI args and extracts XML-enveloped tool calls", () => {
    expect(buildClaudeCliArgs("sonnet")).toContain("--no-session-persistence");
    expect(buildCodexCliArgs("gpt-5.4", "/tmp/work")).toContain("--ephemeral");

    const parsed = parseCliAssistantOutput(
      `Checking status...\n<acompany_tool_call>{"name":"get_status","arguments":{"env":"prod"}}</acompany_tool_call>`,
    );
    expect(parsed.text).toBe("Checking status...");
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]?.name).toBe("get_status");
    expect(parsed.toolCalls[0]?.arguments).toEqual({ env: "prod" });

    const prompt = buildCliTurnPrompt({
      systemPrompt: "Be concise.",
      messages: [{ role: "user", content: "Ping", timestamp: 1 }],
      tools: [],
    });
    expect(prompt).toContain("Be concise.");
    expect(prompt).toContain("[USER]\nPing");
  });

  it("runs a multi-step tool call + final answer turn through PiAgentRuntime using claude-cli and codex-cli", async () => {
    let callStep = 0;
    setLocalCliRunnerForTests(async ({ binary, args, stdin }) => {
      callStep += 1;
      if (callStep === 1) {
        expect(binary).toContain("claude");
        expect(args).toContain("sonnet");
        expect(stdin).toContain("get_weather");
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            type: "result",
            subtype: "success",
            result: `<acompany_tool_call>{"id":"tc_1","name":"get_weather","arguments":{"city":"Hanoi"}}</acompany_tool_call>`,
            usage: { input_tokens: 30, output_tokens: 15 },
          }),
        };
      }
      expect(stdin).toContain("26C sunny");
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          result: "Hanoi is currently 26C and sunny.",
          usage: { input_tokens: 45, output_tokens: 10 },
        }),
      };
    });

    const runtime = new PiAgentRuntime();
    let toolInvokedWith: Record<string, unknown> | undefined;
    const events = [];
    for await (const ev of runtime.run({
      runId: "run_cli_test_1",
      botId: "bot_1",
      threadId: "thread_1",
      instructions: "You are a helpful teammate.",
      prompt: "What is the weather in Hanoi?",
      history: [],
      model: {
        provider: CLAUDE_CLI_PROVIDER_ID,
        id: "sonnet",
      },
      tools: [
        {
          name: "get_weather",
          description: "Fetch current weather by city.",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
      executeTool: async (name, args) => {
        expect(name).toBe("get_weather");
        toolInvokedWith = args;
        return { ok: true, output: "26C sunny" };
      },
    })) {
      events.push(ev);
    }

    expect(toolInvokedWith).toEqual({ city: "Hanoi" });
    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({
      type: "done",
      text: "Hanoi is currently 26C and sunny.",
    });
  });
});
