export interface TeamBlueprintBot {
  name: string;
  title: string;
  description: string;
  instructions: string;
  computerMode?: "team" | "dedicated";
  modelProvider?: string;
  modelId?: string;
  connectors?: string[];
  routines?: string[];
}

export interface TeamBlueprint {
  version: 1;
  name: string;
  description: string;
  playbook: string;
  bots: TeamBlueprintBot[];
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi,
  /\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9._-]{12,}["']?/gi,
];

export function redactBlueprintSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, keyName) => {
      if (typeof keyName === "string" && keyName.length > 0) {
        return `${keyName}: [REDACTED]`;
      }
      return "[REDACTED]";
    });
  }
  return out;
}

function escapeYamlString(value: string): string {
  return JSON.stringify(redactBlueprintSecrets(value));
}

function unescapeYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    if (trimmed.startsWith('"')) {
      try {
        return String(JSON.parse(trimmed));
      } catch {
        return trimmed.slice(1, -1);
      }
    }
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function splitFrontmatter(markdown: string): { frontmatter: string; body: string } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error("Blueprint must start with YAML frontmatter (---).");
  }
  const endIndex = normalized.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    const trailingEnd = normalized.endsWith("\n---") ? normalized.length - 4 : -1;
    if (trailingEnd === -1) {
      throw new Error("Blueprint frontmatter is missing closing ---.");
    }
    return {
      frontmatter: normalized.slice(4, trailingEnd),
      body: "",
    };
  }
  return {
    frontmatter: normalized.slice(4, endIndex),
    body: normalized.slice(endIndex + 5).trim(),
  };
}

export function serializeTeamBlueprint(blueprint: TeamBlueprint): string {
  const lines: string[] = [
    "---",
    `version: ${blueprint.version}`,
    `name: ${escapeYamlString(blueprint.name)}`,
    `description: ${escapeYamlString(blueprint.description)}`,
    "bots:",
  ];

  for (const bot of blueprint.bots) {
    lines.push(`  - name: ${escapeYamlString(bot.name)}`);
    lines.push(`    title: ${escapeYamlString(bot.title)}`);
    lines.push(`    description: ${escapeYamlString(bot.description)}`);
    lines.push(`    instructions: ${escapeYamlString(bot.instructions)}`);
    if (bot.computerMode) {
      lines.push(`    computerMode: ${escapeYamlString(bot.computerMode)}`);
    }
    if (bot.modelProvider) {
      lines.push(`    modelProvider: ${escapeYamlString(bot.modelProvider)}`);
    }
    if (bot.modelId) {
      lines.push(`    modelId: ${escapeYamlString(bot.modelId)}`);
    }
    if (bot.connectors && bot.connectors.length > 0) {
      lines.push(
        `    connectors: [${bot.connectors.map((item) => escapeYamlString(item)).join(", ")}]`,
      );
    }
    if (bot.routines && bot.routines.length > 0) {
      lines.push(
        `    routines: [${bot.routines.map((item) => escapeYamlString(item)).join(", ")}]`,
      );
    }
  }

  lines.push("---");
  const safePlaybook = redactBlueprintSecrets(blueprint.playbook.trim());
  if (safePlaybook) {
    lines.push("", safePlaybook);
  }
  return `${lines.join("\n")}\n`;
}

function parseInlineArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return [];
  }
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => unescapeYamlScalar(item))
      .filter(Boolean);
  }
}

export function parseTeamBlueprint(markdown: string): TeamBlueprint {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const lines = frontmatter.split("\n");

  let version = 1;
  let name = "";
  let description = "";
  const bots: TeamBlueprintBot[] = [];
  let inBots = false;
  let currentBot: Partial<TeamBlueprintBot> | null = null;

  const commitBot = () => {
    if (!currentBot) return;
    if (!currentBot.name) {
      throw new Error("Every bot in blueprint must have a name.");
    }
    bots.push({
      name: currentBot.name,
      title: currentBot.title ?? "",
      description: currentBot.description ?? "",
      instructions: currentBot.instructions ?? currentBot.description ?? "",
      ...(currentBot.computerMode ? { computerMode: currentBot.computerMode } : {}),
      ...(currentBot.modelProvider ? { modelProvider: currentBot.modelProvider } : {}),
      ...(currentBot.modelId ? { modelId: currentBot.modelId } : {}),
      ...(currentBot.connectors ? { connectors: currentBot.connectors } : {}),
      ...(currentBot.routines ? { routines: currentBot.routines } : {}),
    });
    currentBot = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;

    if (line.startsWith("  - ") && inBots) {
      commitBot();
      currentBot = {};
      const rest = line.slice(4);
      const colon = rest.indexOf(":");
      if (colon !== -1) {
        const key = rest.slice(0, colon).trim();
        const val = unescapeYamlScalar(rest.slice(colon + 1));
        if (key === "name") currentBot.name = val;
      }
      continue;
    }

    if (line.startsWith("    ") && inBots && currentBot) {
      const rest = line.trim();
      const colon = rest.indexOf(":");
      if (colon === -1) continue;
      const key = rest.slice(0, colon).trim();
      const rawVal = rest.slice(colon + 1).trim();
      if (key === "name") currentBot.name = unescapeYamlScalar(rawVal);
      else if (key === "title") currentBot.title = unescapeYamlScalar(rawVal);
      else if (key === "description") currentBot.description = unescapeYamlScalar(rawVal);
      else if (key === "instructions") currentBot.instructions = unescapeYamlScalar(rawVal);
      else if (key === "modelProvider") currentBot.modelProvider = unescapeYamlScalar(rawVal);
      else if (key === "modelId") currentBot.modelId = unescapeYamlScalar(rawVal);
      else if (key === "computerMode") {
        const mode = unescapeYamlScalar(rawVal);
        if (mode === "team" || mode === "dedicated") {
          currentBot.computerMode = mode;
        } else if (mode === "private") {
          currentBot.computerMode = "dedicated";
        }
      } else if (key === "connectors") currentBot.connectors = parseInlineArray(rawVal);
      else if (key === "routines") currentBot.routines = parseInlineArray(rawVal);
      continue;
    }

    inBots = false;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const rawVal = line.slice(colon + 1).trim();
    if (key === "version") {
      version = Number(unescapeYamlScalar(rawVal)) || 1;
    } else if (key === "name") {
      name = unescapeYamlScalar(rawVal);
    } else if (key === "description") {
      description = unescapeYamlScalar(rawVal);
    } else if (key === "bots") {
      inBots = true;
    }
  }

  commitBot();

  if (!name.trim()) {
    throw new Error("Blueprint requires a top-level name.");
  }
  if (bots.length === 0) {
    throw new Error("Blueprint must include at least one bot.");
  }

  return {
    version: version === 1 ? 1 : 1,
    name: redactBlueprintSecrets(name),
    description: redactBlueprintSecrets(description),
    playbook: redactBlueprintSecrets(body),
    bots,
  };
}
