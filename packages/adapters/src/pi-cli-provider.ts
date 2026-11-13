import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_CLI_PROVIDER_ID,
  CODEX_CLI_PROVIDER_ID,
  GEMINI_CLI_PROVIDER_ID,
  isLocalCliProviderId,
  OPENCODE_CLI_PROVIDER_ID,
} from "@acompany/contracts";
import {
  type Api,
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  createProvider,
  type Model,
  type MutableModels,
  type Provider,
  type SimpleStreamOptions,
  type StreamOptions,
  type Tool,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";

export {
  CLAUDE_CLI_PROVIDER_ID,
  CODEX_CLI_PROVIDER_ID,
  GEMINI_CLI_PROVIDER_ID,
  isLocalCliProviderId,
  OPENCODE_CLI_PROVIDER_ID,
};

export const LOCAL_CLI_PLACEHOLDER_SECRET = "local-cli-session";

export interface LocalCliSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type LocalCliRunner = (input: {
  binary: string;
  args: string[];
  stdin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}) => Promise<LocalCliSpawnResult>;

const CLAUDE_CLI_API = "claude-cli-bridge";
const CODEX_CLI_API = "codex-cli-bridge";
const GEMINI_CLI_API = "gemini-cli-bridge";
const OPENCODE_CLI_API = "opencode-cli-bridge";

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const CLAUDE_CLI_MODELS: Array<{ id: string; name: string; reasoning: boolean }> = [
  { id: "sonnet", name: "Claude Sonnet (Local CLI)", reasoning: true },
  { id: "opus", name: "Claude Opus (Local CLI)", reasoning: true },
  { id: "haiku", name: "Claude Haiku (Local CLI)", reasoning: false },
];

const CODEX_CLI_MODELS: Array<{ id: string; name: string; reasoning: boolean }> = [
  { id: "gpt-5.4", name: "GPT-5.4 (Local Codex CLI)", reasoning: true },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini (Local Codex CLI)", reasoning: true },
  { id: "o3", name: "o3 (Local Codex CLI)", reasoning: true },
];

const GEMINI_CLI_MODELS: Array<{ id: string; name: string; reasoning: boolean }> = [
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro (Local CLI)", reasoning: true },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash (Local CLI)", reasoning: true },
];

const OPENCODE_CLI_MODELS: Array<{ id: string; name: string; reasoning: boolean }> = [
  { id: "default", name: "OpenCode Default Model (Local CLI)", reasoning: true },
];

export function resolveCliBinaryName(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (providerId === CLAUDE_CLI_PROVIDER_ID) {
    return env.ACOMPANY_CLAUDE_CLI_PATH?.trim() || "claude";
  }
  if (providerId === CODEX_CLI_PROVIDER_ID) {
    return env.ACOMPANY_CODEX_CLI_PATH?.trim() || "codex";
  }
  if (providerId === GEMINI_CLI_PROVIDER_ID) {
    return env.ACOMPANY_GEMINI_CLI_PATH?.trim() || "gemini";
  }
  if (providerId === OPENCODE_CLI_PROVIDER_ID) {
    return env.ACOMPANY_OPENCODE_CLI_PATH?.trim() || "opencode";
  }
  throw new Error(`Unsupported local CLI provider: ${providerId}`);
}

/**
 * Checks whether a CLI binary can be located on PATH or at an explicit file path.
 */
export function probeLocalCliAvailable(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): { available: boolean; binary: string } {
  const binary = resolveCliBinaryName(providerId, env);
  if (path.isAbsolute(binary) || binary.includes("/") || binary.includes("\\")) {
    return { available: fs.existsSync(binary), binary };
  }
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [binary], {
    env,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 4_000,
  });
  return { available: result.status === 0, binary };
}

/**
 * Formats Pi conversation context + tool schemas into a deterministic prompt envelope
 * so headless one-shot `claude -p` and `codex exec` runs preserve multi-turn history
 * and A-Company's native tool orchestration (MCP, connectors, computer sandboxes).
 */
export function buildCliTurnPrompt(context: Context): string {
  const sections: string[] = [];

  if (context.systemPrompt?.trim()) {
    sections.push(`<system_instructions>\n${context.systemPrompt.trim()}\n</system_instructions>`);
  }

  if (context.tools?.length) {
    sections.push(formatToolBridgeContract(context.tools));
  }

  const transcript: string[] = [];
  for (const msg of context.messages) {
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .map((part) =>
                part.type === "text" ? part.text : `[attached image: ${part.mimeType}]`,
              )
              .join("\n");
      transcript.push(`[USER]\n${text}`);
    } else if (msg.role === "assistant") {
      const blocks = msg.content.map((part) => {
        if (part.type === "text") return part.text;
        if (part.type === "thinking") return "";
        return `<acompany_tool_call>${JSON.stringify({
          id: part.id,
          name: part.name,
          arguments: part.arguments,
        })}</acompany_tool_call>`;
      });
      const joined = blocks.filter(Boolean).join("\n");
      if (joined) transcript.push(`[ASSISTANT]\n${joined}`);
    } else if (msg.role === "toolResult") {
      const text = msg.content
        .map((part) => (part.type === "text" ? part.text : `[tool image: ${part.mimeType}]`))
        .join("\n");
      transcript.push(
        `[TOOL_RESULT name="${msg.toolName}" id="${msg.toolCallId}" error="${String(msg.isError)}"]\n${text}`,
      );
    }
  }

  if (transcript.length > 0) {
    sections.push(`<conversation_history>\n${transcript.join("\n\n")}\n</conversation_history>`);
  }

  sections.push(
    'Respond directly as the assistant for the latest turn. If you need to invoke one or more tools from <available_tools>, emit ONLY `<acompany_tool_call>{"name":"...","arguments":{...}}</acompany_tool_call>` blocks and wait for the `[TOOL_RESULT]` in the next turn.',
  );

  return sections.join("\n\n");
}

function formatToolBridgeContract(tools: Tool[]): string {
  const defs = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  return [
    "<available_tools>",
    "You have access to the following workspace tools managed by A-Company:",
    JSON.stringify(defs, null, 2),
    "To call a tool, output one or more XML blocks in this exact JSON shape:",
    '<acompany_tool_call>{"name": "tool_name", "arguments": {"key": "value"}}</acompany_tool_call>',
    "Do not fabricate tool outputs.",
    "</available_tools>",
  ].join("\n");
}

/**
 * Extracts `<acompany_tool_call>...</acompany_tool_call>` blocks and remaining plain text
 * from a CLI assistant response.
 */
export function parseCliAssistantOutput(rawText: string): {
  text: string;
  toolCalls: ToolCall[];
} {
  const toolCalls: ToolCall[] = [];
  const pattern = /<acompany_tool_call>\s*([\s\S]*?)\s*<\/acompany_tool_call>/g;
  let index = 0;
  const cleaned = rawText.replace(pattern, (_full, inner: string) => {
    try {
      const parsed = JSON.parse(inner) as {
        id?: string;
        name?: string;
        arguments?: Record<string, unknown>;
      };
      if (parsed && typeof parsed.name === "string" && parsed.name.trim()) {
        index += 1;
        toolCalls.push({
          type: "toolCall",
          id:
            typeof parsed.id === "string" && parsed.id.trim()
              ? parsed.id.trim()
              : `cli_tool_${Date.now()}_${index}`,
          name: parsed.name.trim(),
          arguments:
            parsed.arguments && typeof parsed.arguments === "object" ? parsed.arguments : {},
        });
        return "";
      }
    } catch {
      // Keep malformed block untouched so debugging/text isn't lost silently.
    }
    return _full;
  });

  return {
    text: cleaned.trim(),
    toolCalls,
  };
}

export function buildClaudeCliArgs(modelId: string): string[] {
  return [
    "-p",
    "--model",
    modelId,
    "--output-format",
    "json",
    "--tools",
    "",
    "--no-session-persistence",
    "--strict-mcp-config",
  ];
}

export function buildCodexCliArgs(modelId: string, cwd: string): string[] {
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--cd",
    cwd,
    "--model",
    modelId,
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
    "-",
  ];
}

export function buildGeminiCliArgs(modelId: string): string[] {
  return ["-p", "", "--model", modelId, "--output-format", "json"];
}

export function buildOpenCodeCliArgs(modelId: string): string[] {
  const base = ["run", "--format", "json"];
  if (modelId && modelId !== "default") {
    base.push("--model", modelId);
  }
  return base;
}

export function extractGeminiCliJsonOutput(stdout: string): { text: string; usage: Usage } {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: "", usage: ZERO_USAGE };
  try {
    const parsed = JSON.parse(trimmed) as {
      response?: string;
      text?: string;
      error?: { message?: string } | string;
      stats?: { models?: Record<string, { tokens?: { prompt?: number; candidates?: number } }> };
    };
    if (parsed.error) {
      throw new Error(
        typeof parsed.error === "string"
          ? parsed.error
          : parsed.error.message || "Gemini CLI error",
      );
    }
    let input = 0;
    let output = 0;
    for (const modelStats of Object.values(parsed.stats?.models ?? {})) {
      input += Number(modelStats.tokens?.prompt ?? 0);
      output += Number(modelStats.tokens?.candidates ?? 0);
    }
    return {
      text: parsed.response ?? parsed.text ?? trimmed,
      usage: {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
  } catch (error) {
    if (error instanceof SyntaxError) return { text: trimmed, usage: ZERO_USAGE };
    throw error;
  }
}

export function extractOpenCodeCliJsonOutput(stdout: string): { text: string; usage: Usage } {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let input = 0;
  let output = 0;
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as {
        type?: string;
        part?: { type?: string; text?: string; tokens?: { input?: number; output?: number } };
        text?: string;
        error?: { message?: string };
      };
      if (ev.type === "error" && ev.error?.message) {
        throw new Error(ev.error.message);
      }
      if (ev.type === "text" && typeof ev.part?.text === "string") {
        chunks.push(ev.part.text);
      } else if (typeof ev.text === "string") {
        chunks.push(ev.text);
      }
      if (ev.type === "step_finish" && ev.part?.tokens) {
        input += Number(ev.part.tokens.input ?? 0);
        output += Number(ev.part.tokens.output ?? 0);
      }
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return {
    text: chunks.length > 0 ? chunks.join("") : stdout.trim(),
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

export function extractClaudeCliJsonOutput(stdout: string): { text: string; usage: Usage } {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: "", usage: ZERO_USAGE };
  // Claude `--output-format json` emits either a single JSON object or NDJSON ending in type="result".
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const frame = JSON.parse(lines[i]!) as {
        type?: string;
        subtype?: string;
        is_error?: boolean;
        result?: string;
        errors?: string[];
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };
      if (frame.is_error) {
        const reason =
          (Array.isArray(frame.errors) && frame.errors.join("; ")) ||
          frame.result ||
          "Claude CLI reported an error";
        throw new Error(reason);
      }
      if (typeof frame.result === "string") {
        const input = Number(frame.usage?.input_tokens ?? 0);
        const output = Number(frame.usage?.output_tokens ?? 0);
        const cacheRead = Number(frame.usage?.cache_read_input_tokens ?? 0);
        const cacheWrite = Number(frame.usage?.cache_creation_input_tokens ?? 0);
        return {
          text: frame.result,
          usage: {
            input,
            output,
            cacheRead,
            cacheWrite,
            totalTokens: input + output + cacheRead + cacheWrite,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
      }
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return { text: trimmed, usage: ZERO_USAGE };
}

export function extractCodexCliJsonOutput(stdout: string): { text: string; usage: Usage } {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let lastMessage = "";
  let failure = "";
  let usage: Usage = ZERO_USAGE;

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = event.type;
    if (type === "item.completed") {
      const item = (event.item ?? {}) as { type?: string; text?: string };
      if (item.type === "agent_message" && typeof item.text === "string") {
        lastMessage = item.text;
      }
    } else if (type === "turn.completed") {
      const u = (event.usage ?? {}) as {
        input_tokens?: number;
        output_tokens?: number;
        cached_input_tokens?: number;
      };
      const input = Number(u.input_tokens ?? 0);
      const output = Number(u.output_tokens ?? 0);
      const cacheRead = Number(u.cached_input_tokens ?? 0);
      usage = {
        input,
        output,
        cacheRead,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
    } else if (type === "turn.failed") {
      const err = (event.error ?? {}) as { message?: string };
      failure = err.message || "Codex CLI turn failed";
    } else if (type === "error" && typeof event.message === "string" && !failure) {
      failure = event.message;
    }
  }

  if (failure) {
    throw new Error(failure);
  }
  return { text: lastMessage || stdout.trim(), usage };
}

export const defaultLocalCliRunner: LocalCliRunner = async ({
  binary,
  args,
  stdin,
  cwd,
  env,
  signal,
}) => {
  return new Promise<LocalCliSpawnResult>((resolve, reject) => {
    const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(binary);
    const child = spawn(binary, args, {
      cwd,
      env,
      shell: useShell,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (err?: Error, result?: LocalCliSpawnResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve(result!);
    };

    const onAbort = () => {
      child.kill("SIGTERM");
      finish(new Error("Local CLI request was aborted"));
    };

    if (signal?.aborted) {
      child.kill("SIGTERM");
      return finish(new Error("Local CLI request was aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_384);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        finish(
          new Error(
            `Local CLI binary "${binary}" was not found on PATH. Install it and sign in on this machine first.`,
          ),
        );
        return;
      }
      finish(error);
    });
    child.on("close", (exitCode) => {
      finish(undefined, { stdout, stderr, exitCode });
    });

    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
};

let activeCliRunner: LocalCliRunner = defaultLocalCliRunner;

/** Allows deterministic offline unit tests to stub CLI subprocess execution. */
export function setLocalCliRunnerForTests(runner: LocalCliRunner | undefined): void {
  activeCliRunner = runner ?? defaultLocalCliRunner;
}

type SupportedCliProviderId =
  | typeof CLAUDE_CLI_PROVIDER_ID
  | typeof CODEX_CLI_PROVIDER_ID
  | typeof GEMINI_CLI_PROVIDER_ID
  | typeof OPENCODE_CLI_PROVIDER_ID;

function createCliStream(providerId: SupportedCliProviderId, apiName: string) {
  return (model: Model<Api>, context: Context, options?: StreamOptions | SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    const signal = options?.signal;

    queueMicrotask(async () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acompany-local-cli-"));
      const basePartial: AssistantMessage = {
        role: "assistant",
        content: [],
        api: apiName,
        provider: providerId,
        model: model.id,
        usage: ZERO_USAGE,
        stopReason: "pending",
        timestamp: Date.now(),
      };

      try {
        if (signal?.aborted) {
          const aborted: AssistantMessage = {
            ...basePartial,
            stopReason: "aborted",
            errorMessage: "Request was aborted",
          };
          stream.push({ type: "error", reason: "aborted", error: aborted });
          stream.end(aborted);
          return;
        }

        const prompt = buildCliTurnPrompt(context);
        const binary = resolveCliBinaryName(providerId, process.env);
        const args =
          providerId === CLAUDE_CLI_PROVIDER_ID
            ? buildClaudeCliArgs(model.id)
            : providerId === CODEX_CLI_PROVIDER_ID
              ? buildCodexCliArgs(model.id, cwd)
              : providerId === GEMINI_CLI_PROVIDER_ID
                ? buildGeminiCliArgs(model.id)
                : buildOpenCodeCliArgs(model.id);

        const result = await activeCliRunner({
          binary,
          args,
          stdin: prompt,
          cwd,
          env: { ...process.env },
          signal,
        });

        const extracted =
          providerId === CLAUDE_CLI_PROVIDER_ID
            ? extractClaudeCliJsonOutput(result.stdout)
            : providerId === CODEX_CLI_PROVIDER_ID
              ? extractCodexCliJsonOutput(result.stdout)
              : providerId === GEMINI_CLI_PROVIDER_ID
                ? extractGeminiCliJsonOutput(result.stdout)
                : extractOpenCodeCliJsonOutput(result.stdout);

        if (result.exitCode !== 0 && !extracted.text.trim()) {
          const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
          throw new Error(`${providerId} failed: ${detail}`);
        }

        const parsed = parseCliAssistantOutput(extracted.text);
        const content: AssistantMessage["content"] = [];
        if (parsed.text) {
          content.push({ type: "text", text: parsed.text });
        }
        for (const call of parsed.toolCalls) {
          content.push(call);
        }

        const stopReason: AssistantMessage["stopReason"] =
          parsed.toolCalls.length > 0 ? "toolUse" : "stop";

        const partial: AssistantMessage = {
          ...basePartial,
          usage: extracted.usage,
          content: [],
        };
        stream.push({ type: "start", partial: { ...partial } });

        let idx = 0;
        if (parsed.text) {
          partial.content = [...partial.content, { type: "text", text: "" }];
          stream.push({ type: "text_start", contentIndex: idx, partial: { ...partial } });
          (partial.content[idx] as { type: "text"; text: string }).text = parsed.text;
          stream.push({
            type: "text_delta",
            contentIndex: idx,
            delta: parsed.text,
            partial: { ...partial },
          });
          stream.push({
            type: "text_end",
            contentIndex: idx,
            content: parsed.text,
            partial: { ...partial },
          });
          idx += 1;
        }

        for (const call of parsed.toolCalls) {
          partial.content = [
            ...partial.content,
            { type: "toolCall", id: call.id, name: call.name, arguments: {} },
          ];
          stream.push({ type: "toolcall_start", contentIndex: idx, partial: { ...partial } });
          const rawArgs = JSON.stringify(call.arguments);
          stream.push({
            type: "toolcall_delta",
            contentIndex: idx,
            delta: rawArgs,
            partial: { ...partial },
          });
          (partial.content[idx] as ToolCall).arguments = call.arguments;
          stream.push({
            type: "toolcall_end",
            contentIndex: idx,
            toolCall: call,
            partial: { ...partial },
          });
          idx += 1;
        }

        const finalMessage: AssistantMessage = {
          ...basePartial,
          content,
          usage: extracted.usage,
          stopReason,
          timestamp: Date.now(),
        };
        stream.push({ type: "done", reason: stopReason, message: finalMessage });
        stream.end(finalMessage);
      } catch (error) {
        const isAbort = signal?.aborted;
        const failedMessage: AssistantMessage = {
          ...basePartial,
          stopReason: isAbort ? "aborted" : "error",
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        };
        stream.push({
          type: "error",
          reason: isAbort ? "aborted" : "error",
          error: failedMessage,
        });
        stream.end(failedMessage);
      } finally {
        try {
          fs.rmSync(cwd, { recursive: true, force: true });
        } catch {
          // Ignore Windows transient lock on temp directory cleanup.
        }
      }
    });

    return stream;
  };
}

function buildLocalCliProvider(
  providerId: SupportedCliProviderId,
  providerName: string,
  apiName: string,
  defs: Array<{ id: string; name: string; reasoning: boolean }>,
): Provider {
  const streamFn = createCliStream(providerId, apiName);
  const models: Model<Api>[] = defs.map((def) => ({
    id: def.id,
    name: def.name,
    api: apiName,
    provider: providerId,
    baseUrl: "http://127.0.0.1:0",
    reasoning: def.reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  }));

  return createProvider({
    id: providerId,
    name: providerName,
    baseUrl: "http://127.0.0.1:0",
    auth: {
      apiKey: {
        name: `${providerName} session`,
        resolve: async () => ({
          auth: { apiKey: LOCAL_CLI_PLACEHOLDER_SECRET },
          source: providerName,
        }),
      },
    },
    models,
    api: {
      stream: streamFn,
      streamSimple: streamFn,
    },
  });
}

export function claudeCliProvider(): Provider {
  return buildLocalCliProvider(
    CLAUDE_CLI_PROVIDER_ID,
    "Claude Code CLI (Local)",
    CLAUDE_CLI_API,
    CLAUDE_CLI_MODELS,
  );
}

export function codexCliProvider(): Provider {
  return buildLocalCliProvider(
    CODEX_CLI_PROVIDER_ID,
    "Codex CLI (Local)",
    CODEX_CLI_API,
    CODEX_CLI_MODELS,
  );
}

export function geminiCliProvider(): Provider {
  return buildLocalCliProvider(
    GEMINI_CLI_PROVIDER_ID,
    "Gemini CLI (Local)",
    GEMINI_CLI_API,
    GEMINI_CLI_MODELS,
  );
}

export function openCodeCliProvider(): Provider {
  return buildLocalCliProvider(
    OPENCODE_CLI_PROVIDER_ID,
    "OpenCode CLI (Local)",
    OPENCODE_CLI_API,
    OPENCODE_CLI_MODELS,
  );
}

export function registerLocalCliProviders(models: MutableModels): MutableModels {
  if (typeof models.setProvider !== "function") return models;
  models.setProvider(claudeCliProvider());
  models.setProvider(codexCliProvider());
  models.setProvider(geminiCliProvider());
  models.setProvider(openCodeCliProvider());
  return models;
}
