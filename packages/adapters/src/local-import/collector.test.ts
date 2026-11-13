import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import type { ImportPacket, PortableImportBundle } from "@acompany/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalImportCollector } from "./collector.js";

const roots: string[] = [];
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "a-company-local-import-"));
  roots.push(home);
  const hermes = join(home, ".hermes");
  const codex = join(home, ".codex");
  const project = join(home, "work", "demo");
  await Promise.all([
    mkdir(hermes, { recursive: true }),
    mkdir(join(codex, "sessions", "2026", "01", "01"), { recursive: true }),
    mkdir(project, { recursive: true }),
  ]);
  await writeFile(join(project, "main.ts"), 'export const greeting = "hello";');
  await writeFile(join(project, ".env"), "PRIVATE_TEST_VALUE=not-for-import");
  const db = new DatabaseSync(join(hermes, "state.db"));
  db.exec(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, started_at REAL, message_count INTEGER, model TEXT, parent_session_id TEXT); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, tool_calls TEXT, tool_name TEXT, active INTEGER, compacted INTEGER);",
  );
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "session-demo",
    "Demo history",
    project,
    1_700_000_000,
    2,
    "example-model",
    null,
  );
  db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    1,
    "session-demo",
    "user",
    "Build a greeting",
    1_700_000_000,
    null,
    null,
    1,
    0,
  );
  db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    2,
    "session-demo",
    "assistant",
    "Here is the greeting",
    1_700_000_001,
    null,
    null,
    1,
    0,
  );
  db.close();
  const skill = join(hermes, "skills", "development", "demo-skill");
  await mkdir(join(skill, "scripts"), { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: demo-skill\ndescription: A fake fixture skill\n---\nUse scripts/check.py.\n",
  );
  await writeFile(join(skill, "scripts", "check.py"), 'print("fixture-only")\n');
  const rollout = join(codex, "sessions", "2026", "01", "01", "rollout-demo.jsonl");
  await writeFile(
    rollout,
    `${[
      {
        timestamp: "2026-01-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "codex-demo", cwd: project, cli_version: "fixture-only" },
      },
      {
        timestamp: "2026-01-01T00:00:01Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Build a Codex greeting" },
      },
      {
        timestamp: "2026-01-01T00:00:01Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Build a Codex greeting" }],
        },
      },
      {
        timestamp: "2026-01-01T00:00:02Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          arguments: '{"command":"fixture-only"}',
          call_id: "call-demo",
        },
      },
      {
        timestamp: "2026-01-01T00:00:03Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-demo", output: "fixture result" },
      },
      {
        timestamp: "2026-01-01T00:00:04Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Codex greeting done" }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
  );
  return {
    home,
    hermes,
    codex,
    project,
    rollout,
    collector: createLocalImportCollector({
      homeDir: home,
      env: { HERMES_HOME: hermes, CODEX_HOME: codex },
    }),
  };
}
function unpack(packet: ImportPacket): PortableImportBundle {
  return JSON.parse(gunzipSync(Buffer.from(packet.data, "base64")).toString("utf8"));
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local source collection", () => {
  it("discovers metadata then exports only selected Hermes data as an independent portable copy", async () => {
    const { collector, hermes } = await fixture();
    const before = createHash("sha256")
      .update(await readFile(join(hermes, "state.db")))
      .digest("hex");
    const scan = await collector.scan();
    expect(
      scan.sources.filter((source) => source.available).map((source) => source.source),
    ).toEqual(["hermes", "codex"]);
    expect(scan.sessions).toHaveLength(2);
    expect(scan.skills).toHaveLength(1);
    const session = scan.sessions.find((entry) => entry.source === "hermes");
    expect(session?.messageCount).toBe(2);
    const project = scan.projects.find((entry) => entry.id === session?.projectId);
    expect(project?.fileCount).toBeNull();
    const packet = await collector.bundle({
      projectIds: [project?.id ?? ""],
      sessionIds: [session?.id ?? ""],
      skillIds: scan.skills.map((entry) => entry.id),
    });
    const bundle = unpack(packet);
    expect(bundle.projects).toHaveLength(1);
    expect(bundle.projects[0]?.files.map((file) => file.path)).toEqual(["main.ts"]);
    expect(
      Buffer.from(bundle.projects[0]?.files[0]?.contentBase64 ?? "", "base64").toString(),
    ).toContain("hello");
    expect(bundle.sessions[0]?.messages.map((message) => message.content)).toEqual([
      "Build a greeting",
      "Here is the greeting",
    ]);
    expect(bundle.skills[0]?.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "scripts/check.py",
    ]);
    expect(bundle.warnings).toContain("SKILLS_ARCHIVED_INACTIVE");
    expect(JSON.stringify(bundle)).not.toContain("not-for-import");
    expect(
      createHash("sha256")
        .update(await readFile(join(hermes, "state.db")))
        .digest("hex"),
    ).toBe(before);
  });
  it("preserves Codex tool records and original events without duplicating visible user turns", async () => {
    const { collector } = await fixture();
    const scan = await collector.scan();
    const session = scan.sessions.find((entry) => entry.source === "codex");
    expect(session?.messageCount).toBeNull();
    const result = unpack(
      await collector.bundle({ projectIds: [], sessionIds: [session?.id ?? ""], skillIds: [] }),
    );
    const imported = result.sessions[0];
    expect(imported?.messages).toHaveLength(6);
    expect(
      imported?.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["Build a Codex greeting"]);
    expect(imported?.messages.find((message) => message.role === "tool")?.content).toBe(
      "fixture result",
    );
    expect(
      imported?.messages.find((message) => message.role === "tool_call")?.original,
    ).toMatchObject({ payload: { name: "shell", call_id: "call-demo" } });
    expect(imported?.messages[0]?.original).toMatchObject({
      type: "session_meta",
      payload: { cli_version: "fixture-only" },
    });
    expect(imported?.projectId).toBeUndefined();
    expect(result.warnings).toContain("PROJECT_NOT_SELECTED");
  });
  it("requires explicit opt-in before transferring credential containers and preserves raw chosen values only after approval", async () => {
    const { collector, hermes, project } = await fixture();
    const fake = ["sk", "fixture", "portable", "0123456789"].join("-");
    await writeFile(join(hermes, "auth.json"), JSON.stringify({ access_token: fake }));
    await writeFile(join(hermes, ".env"), `MODEL_API_KEY=${fake}\n`);
    const db = new DatabaseSync(join(hermes, "state.db"));
    db.prepare("UPDATE messages SET content = ? WHERE id = 2").run(
      JSON.stringify({ access_token: fake }),
    );
    db.close();
    const scan = await collector.scan();
    const credential = scan.sensitiveSources?.find((entry) => entry.source === "hermes");
    expect(credential?.fileCount).toBe(2);
    expect(JSON.stringify(scan)).not.toContain(fake);
    const session = scan.sessions.find((entry) => entry.source === "hermes");
    const selection = {
      projectIds: [session?.projectId ?? ""],
      sessionIds: [session?.id ?? ""],
      skillIds: [],
      sensitiveSourceIds: [credential?.id ?? ""],
    };
    await expect(collector.bundle(selection)).rejects.toThrow("Explicit sensitive-data consent");
    const packet = await collector.bundle({ ...selection, includeSensitiveData: true });
    expect(packet.includeSensitiveData).toBe(true);
    const included = unpack(packet);
    expect(included.includeSensitiveData).toBe(true);
    expect(included.sensitiveSources?.[0]?.files.map((entry) => entry.path)).toEqual([
      ".env",
      "auth.json",
    ]);
    expect(
      Buffer.from(
        included.sensitiveSources?.[0]?.files.find((entry) => entry.path === "auth.json")
          ?.contentBase64 ?? "",
        "base64",
      ).toString(),
    ).toContain(fake);
    expect(included.sessions[0]?.messages[1]?.content).toContain(fake);
    expect(included.projects[0]?.files.map((entry) => entry.path)).toContain(".env");
    expect(await readFile(join(project, ".env"), "utf8")).toBe("PRIVATE_TEST_VALUE=not-for-import");
    const excluded = unpack(
      await collector.bundle({
        projectIds: selection.projectIds,
        sessionIds: selection.sessionIds,
        skillIds: [],
      }),
    );
    expect(excluded.sensitiveSources ?? []).toHaveLength(0);
    expect(excluded.projects[0]?.files.map((entry) => entry.path)).not.toContain(".env");
    expect(JSON.stringify(excluded)).not.toContain(fake);
  });
  it("rejects use before scanning and identifiers that were not discovered", async () => {
    const { collector } = await fixture();
    await expect(
      collector.bundle({ projectIds: [], sessionIds: ["invented"], skillIds: [] }),
    ).rejects.toThrow("scan");
    await collector.scan();
    await expect(
      collector.bundle({ projectIds: ["../../outside"], sessionIds: [], skillIds: [] }),
    ).rejects.toThrow("Unknown import selection");
    await expect(
      collector.bundle({ projectIds: [], sessionIds: [], skillIds: [] }),
    ).rejects.toThrow("Choose at least one");
  });
  it("does not follow directory junctions into files outside the selected project", async () => {
    const { collector, home, project } = await fixture();
    const outside = join(home, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "private.txt"), "must-not-cross-boundary");
    await symlink(outside, join(project, "linked"), "junction");
    const scan = await collector.scan();
    const result = unpack(
      await collector.bundle({
        projectIds: scan.projects.slice(0, 1).map((entry) => entry.id),
        sessionIds: [],
        skillIds: [],
      }),
    );
    expect(result.projects[0]?.files.map((file) => file.path)).toEqual(["main.ts"]);
    expect(result.warnings).toContain("SYMLINKS_EXCLUDED");
    expect(JSON.stringify(result)).not.toContain("must-not-cross-boundary");
  });
  it("redacts known secrets in project and session copies while leaving the source unchanged", async () => {
    const { collector, hermes, project } = await fixture();
    const fake = "sk-test-portable-only-0123456789";
    const source = `const apiKey = "${fake}";`;
    await writeFile(join(project, "example.ts"), source);
    const db = new DatabaseSync(join(hermes, "state.db"));
    db.prepare("UPDATE messages SET content = ? WHERE id = 2").run(
      JSON.stringify({ access_token: "opaque-fixture-only" }),
    );
    db.close();
    const scan = await collector.scan();
    const session = scan.sessions.find((entry) => entry.source === "hermes");
    const result = unpack(
      await collector.bundle({
        projectIds: [session?.projectId ?? ""],
        sessionIds: [session?.id ?? ""],
        skillIds: [],
      }),
    );
    expect(JSON.stringify(result)).not.toContain("opaque-fixture-only");
    expect(result.sessions[0]?.messages[1]?.content).toContain("[REDACTED]");
    const copied = result.projects[0]?.files.find((file) => file.path === "example.ts");
    expect(Buffer.from(copied?.contentBase64 ?? "", "base64").toString()).not.toContain(fake);
    expect(await readFile(join(project, "example.ts"), "utf8")).toBe(source);
    expect(result.warnings).toContain("KNOWN_SECRETS_REDACTED");
  });
});
