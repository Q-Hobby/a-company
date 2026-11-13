import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { EncryptedSecretStore, PortableImportStore } from "@acompany/adapters";
import type { ImportPacket, LocalImportScan, PortableImportBundle } from "@acompany/contracts";
import { afterEach, expect, it } from "vitest";
import { createLocalImportCollector } from "../../adapters/src/local-import/collector.js";
import { startLocalImportServer } from "../../adapters/src/local-import/server.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

it("pairs over real HTTP, transfers selected local data, encrypts sensitive originals and survives removal of the source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portable-import-integration-"));
  roots.push(root);
  const home = path.join(root, "source");
  const hermes = path.join(home, ".hermes");
  const project = path.join(home, "work", "example");
  const skill = path.join(hermes, "skills", "example-skill");
  const dataDir = path.join(root, "destination");
  const fake = ["sk", "test", "integration", "0123456789"].join("-");
  await Promise.all([
    mkdir(hermes, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(path.join(skill, "scripts"), { recursive: true }),
  ]);
  await writeFile(path.join(project, "main.ts"), 'export const message = "independent";');
  await writeFile(path.join(project, ".env"), `ACCESS_TOKEN=${fake}\n`);
  await writeFile(path.join(hermes, "auth.json"), JSON.stringify({ access_token: fake }));
  await writeFile(
    path.join(skill, "SKILL.md"),
    "---\nname: example-skill\ndescription: Offline fixture\n---\nRead scripts/check.py only after approval.\n",
  );
  await writeFile(
    path.join(skill, "scripts", "check.py"),
    'raise SystemExit("fixture scripts stay inactive")\n',
  );
  const database = new DatabaseSync(path.join(hermes, "state.db"));
  database.exec(
    "CREATE TABLE sessions(id TEXT, title TEXT, cwd TEXT, started_at REAL, message_count INTEGER); CREATE TABLE messages(id INTEGER, session_id TEXT, role TEXT, content TEXT, timestamp REAL);",
  );
  database
    .prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)")
    .run("session-fixture", "Offline integration", project, 1_700_000_000, 1);
  database
    .prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?)")
    .run(
      1,
      "session-fixture",
      "user",
      JSON.stringify({ access_token: fake, task: "Keep my source independent" }),
      1_700_000_000,
    );
  database.close();
  const collector = createLocalImportCollector({
    homeDir: home,
    env: { HERMES_HOME: hermes, CODEX_HOME: path.join(home, ".codex") },
  });
  const appOrigin = "http://127.0.0.1:5173";
  const server = await startLocalImportServer({ collector, port: 0, allowedOrigins: [appOrigin] });
  try {
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("Fixture helper did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/scan`, { headers: { Origin: appOrigin } })).status).toBe(401);
    const page = await (
      await fetch(`${base}/connect?origin=${encodeURIComponent(appOrigin)}`)
    ).text();
    const nonce = /name="nonce" value="([a-f0-9]{64})"/.exec(page)?.[1];
    if (!nonce) throw new Error("Fixture helper approval nonce unavailable");
    const approved = await fetch(`${base}/approve`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nonce }),
    });
    expect(approved.ok).toBe(true);
    const approvedPage = await approved.text();
    const capability = /capability:"([a-f0-9]{64})"/.exec(approvedPage)?.[1];
    if (!capability) throw new Error("Fixture helper approval did not return a capability");
    const headers = { Origin: appOrigin, Authorization: `Bearer ${capability}` };
    const scanResponse = await fetch(`${base}/scan`, { headers });
    expect(scanResponse.ok).toBe(true);
    const scan = (await scanResponse.json()) as LocalImportScan;
    expect(JSON.stringify(scan)).not.toContain(fake);
    const selection = {
      projectIds: scan.projects.map((entry) => entry.id),
      sessionIds: scan.sessions.map((entry) => entry.id),
      skillIds: scan.skills.map((entry) => entry.id),
      sensitiveSourceIds: (scan.sensitiveSources ?? []).map((entry) => entry.id),
      includeSensitiveData: true,
    };
    const response = await fetch(`${base}/bundle`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ selection }),
    });
    expect(response.ok).toBe(true);
    const packet = (await response.json()) as ImportPacket;
    const owner = { userId: "integration-fixture-user", spaceId: "integration-fixture-space" };
    const encryption = new EncryptedSecretStore("integration-fixture-encryption-key");
    const destination = new PortableImportStore(dataDir, encryption);
    const preview = destination.preview(packet);
    expect(preview.includeSensitiveData).toBe(true);
    expect(preview.sensitiveSources?.[0]?.fileCount).toBe(1);
    expect(JSON.stringify(preview)).not.toContain(fake);
    await expect(
      destination.commit(owner, packet, { ...selection, includeSensitiveData: false }),
    ).rejects.toThrow();
    const receipt = await destination.commit(owner, packet, selection);
    expect(receipt.projectCount).toBe(1);
    expect(receipt.sessionCount).toBe(1);
    expect(receipt.skillCount).toBe(1);
    await rm(home, { force: true, recursive: true });
    const reopened = new PortableImportStore(dataDir, encryption);
    const archive = await reopened.get(owner, receipt.id);
    expect(JSON.stringify(archive)).not.toContain(fake);
    expect(archive.bundle.projects[0]?.files.map((file) => file.path)).toEqual(["main.ts"]);
    expect(archive.bundle.skills[0]?.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "scripts/check.py",
    ]);
    const copied = (await reopened.files(owner, receipt.id)).find((file) =>
      file.path.endsWith("/main.ts"),
    );
    if (!copied) throw new Error("Independent project file unavailable");
    expect(await readFile(copied.archivePath, "utf8")).toContain("independent");
    const plain = await reopened.export(owner, receipt.id);
    const safe = JSON.parse(
      gunzipSync(Buffer.from(plain.packet.data, "base64")).toString(),
    ) as PortableImportBundle;
    expect(JSON.stringify(safe)).not.toContain(fake);
    expect(safe.warnings).not.toContain("SENSITIVE_DATA_INCLUDED_INACTIVE");
    const original = await reopened.export(owner, receipt.id, true);
    const raw = JSON.parse(
      gunzipSync(Buffer.from(original.packet.data, "base64")).toString(),
    ) as PortableImportBundle;
    expect(raw.sessions[0]?.messages[0]?.content).toContain(fake);
    expect(
      Buffer.from(raw.sensitiveSources?.[0]?.files[0]?.contentBase64 ?? "", "base64").toString(),
    ).toContain(fake);
    expect(await reopened.list(owner)).toEqual([receipt]);
    expect(await reopened.commit(owner, packet, selection)).toEqual(receipt);
    await expect(
      reopened.get({ ...owner, userId: "other-fixture-user" }, receipt.id),
    ).rejects.toThrow();
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}, 30_000);
