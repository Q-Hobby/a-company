#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import {
  getStarterTeam,
  listStarterTeams,
  parseTeamBlueprint,
  serializeTeamBlueprint,
} from "../packages/core/src/index.js";

interface RpcBot {
  id: string;
  name: string;
  title?: string;
  description?: string;
  instructions?: string;
  computerMode?: "team" | "dedicated";
  modelProvider?: string | null;
  modelId?: string | null;
}

const baseUrl = (process.env.ACOMPANY_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, "");

async function rpc<T>(procedure: string, input: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${baseUrl}/rpc/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ json: input }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`RPC ${procedure} failed (${response.status}): ${text}`);
  }
  const parsed = JSON.parse(text) as { json?: T };
  return (parsed.json ?? parsed) as T;
}

function usage(): never {
  console.error(
    [
      "Usage: tsx scripts/acompany-cli.ts <command> [args]",
      "",
      "Commands:",
      "  list-bots",
      "  list-starters",
      "  run <botIdOrName> <prompt>",
      "  export-blueprint <out.md> [teamName]",
      "  import-blueprint <in.md>",
      "  apply-starter <slug>",
      "",
      "Env: ACOMPANY_URL (default http://127.0.0.1:5173)",
    ].join("\n"),
  );
  process.exit(2);
  throw new Error("Invalid usage");
}

async function main() {
  const [, , command, ...rest] = process.argv;
  if (!command) usage();

  if (command === "list-starters") {
    for (const entry of listStarterTeams()) {
      console.log(`${entry.slug}\t${entry.blueprint.name}\t(${entry.blueprint.bots.length} bots)`);
    }
    return;
  }

  if (command === "list-bots") {
    const bots = await rpc<RpcBot[]>("bots/list");
    console.log(JSON.stringify(bots, null, 2));
    return;
  }

  if (command === "run") {
    const [target, ...promptParts] = rest;
    const prompt = promptParts.join(" ").trim();
    if (!target || !prompt) usage();
    const bots = await rpc<RpcBot[]>("bots/list");
    const bot = bots.find((b) => b.id === target || b.name.toLowerCase() === target.toLowerCase());
    if (!bot) {
      throw new Error(`Bot not found: ${target}`);
    }
    const result = await rpc("threads/send", { botId: bot.id, text: prompt });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "export-blueprint") {
    const [outFile, teamName = "A-Company Team"] = rest;
    if (!outFile) usage();
    const bots = await rpc<RpcBot[]>("bots/list");
    const markdown = serializeTeamBlueprint({
      version: 1,
      name: teamName,
      description: `Exported from ${baseUrl}`,
      playbook: `# ${teamName}\n\nPortable A-Company team blueprint.`,
      bots: bots.map((b) => ({
        name: b.name,
        title: b.title ?? "",
        description: b.description ?? "",
        instructions: b.instructions ?? "",
        ...(b.computerMode ? { computerMode: b.computerMode } : {}),
        ...(b.modelProvider ? { modelProvider: b.modelProvider } : {}),
        ...(b.modelId ? { modelId: b.modelId } : {}),
      })),
    });
    writeFileSync(outFile, markdown, "utf8");
    console.log(`Exported ${bots.length} bot(s) to ${outFile}`);
    return;
  }

  if (command === "import-blueprint" || command === "apply-starter") {
    const arg = rest[0];
    if (!arg) usage();
    const blueprint =
      command === "apply-starter"
        ? getStarterTeam(arg)
        : parseTeamBlueprint(readFileSync(arg, "utf8"));
    if (!blueprint) {
      throw new Error(`Starter team not found: ${arg}`);
    }
    const created: RpcBot[] = [];
    for (const bot of blueprint.bots) {
      const result = await rpc<RpcBot>("bots/create", {
        name: bot.name,
        title: bot.title,
        description: bot.description,
        instructions: bot.instructions,
        computerMode: bot.computerMode === "dedicated" ? "dedicated" : "team",
      });
      created.push(result);
    }
    console.log(JSON.stringify({ team: blueprint.name, created }, null, 2));
    return;
  }

  usage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
