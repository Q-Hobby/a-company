import { readFileSync } from "node:fs";
import type { PortableImportBundle } from "@acompany/contracts";
import { describe, expect, it } from "vitest";
import { RU_MESSAGES } from "./locales/ru";
import { ZH_MESSAGES } from "./locales/zh";
import { continuationInput, createArchiveRequestGate } from "./portable-import";

const bundle: PortableImportBundle = {
  version: 1,
  exportedAt: "2026-01-01T00:00:00.000Z",
  projects: [{ id: "project", source: "hermes", name: "Demo", files: [] }],
  sessions: [
    { id: "session", source: "hermes", title: "Demo", projectId: "project", messages: [] },
  ],
  skills: [],
  warnings: [],
};

describe("mobile archive continuation", () => {
  it("keeps mobile archive access on the shared safe API without raw exports or host scanning", () => {
    const source = readFileSync(new URL("../app/imports.tsx", import.meta.url), "utf8");
    expect([...source.matchAll(/"(imports\/[a-zA-Z]+)"/g)].map((match) => match[1])).toEqual([
      "imports/list",
      "imports/get",
      "imports/continue",
    ]);
    expect(source).not.toMatch(
      /127\.0\.0\.1|localhost|contentBase64|sensitiveSources|dangerouslySetInnerHTML|WebView|Linking|fetch\(/,
    );
    expect(source).not.toMatch(/\b(?:cause|err|error)\.message/);
    expect(source).toContain('pathname: "/thread"');
    expect(source).toContain("{message.content}");
    const account = readFileSync(new URL("../app/account.tsx", import.meta.url), "utf8");
    expect(account).toContain('router.push("/imports")');
  });
  it("localizes all import screen copy in every supported non-English catalog", () => {
    const source = readFileSync(new URL("../app/imports.tsx", import.meta.url), "utf8");
    const messages = [...source.matchAll(/\bt\(\s*"([^"]+)"/g)].map((match) => match[1]!);
    expect(messages.length).toBeGreaterThan(10);
    for (const message of messages) {
      expect(RU_MESSAGES[message], `ru: ${message}`).toBeTruthy();
      expect(ZH_MESSAGES[message], `zh: ${message}`).toBeTruthy();
    }
  });
  it("explicitly includes the imported associated project when it exists", () => {
    expect(continuationInput("archive", bundle, "session")).toEqual({
      id: "archive",
      sessionId: "session",
      projectId: "project",
    });
  });
  it("omits projects not selected into the archive", () => {
    expect(continuationInput("archive", { ...bundle, projects: [] }, "session")).toEqual({
      id: "archive",
      sessionId: "session",
    });
  });
  it("does not continue a missing session", () => {
    expect(continuationInput("archive", bundle, "missing")).toBeNull();
  });
  it("never forwards sensitive sources, consent flags, originals or file contents", () => {
    expect(
      continuationInput(
        "archive",
        {
          ...bundle,
          includeSensitiveData: true,
          sensitiveSources: [{ id: "private", source: "hermes", name: "Private", files: [] }],
        },
        "session",
      ),
    ).toEqual({ id: "archive", sessionId: "session", projectId: "project" });
  });
});

describe("archive request lifecycle", () => {
  it("invalidates stale reads and aborts their signals", () => {
    const gate = createArchiveRequestGate();
    const old = gate.begin()!;
    const next = gate.begin()!;
    expect(old.isCurrent()).toBe(false);
    expect(old.signal.aborted).toBe(true);
    expect(next.isCurrent()).toBe(true);
    old.finish();
    expect(next.isCurrent()).toBe(true);
  });
  it("locks duplicate continuations until the current operation finishes", () => {
    const gate = createArchiveRequestGate();
    const first = gate.begin(true)!;
    expect(gate.begin(true)).toBeNull();
    first.finish();
    expect(first.isCurrent()).toBe(false);
    expect(gate.begin(true)).not.toBeNull();
  });
  it("suppresses completions after unmount or archive change, including remount", () => {
    const gate = createArchiveRequestGate();
    const old = gate.begin(true)!;
    gate.invalidate();
    expect(old.isCurrent()).toBe(false);
    expect(old.signal.aborted).toBe(true);
    const next = gate.begin(true)!;
    old.finish();
    expect(next.isCurrent()).toBe(true);
  });
});
