import { describe, expect, it } from "vitest";
import { isExcludedImportPath, redactImportText, sanitizeImportValue } from "./security.js";

describe("portable import secret boundaries", () => {
  it("redacts known credential values without erasing ordinary source text", () => {
    const fake = "sk-test-portable-only-0123456789";
    const text = `const greeting = "hello";\napi_key = "${fake}";\nAuthorization: Bearer fake-bearer-only\nhttps://demo:fake-pass@example.invalid/repo`;
    const clean = redactImportText(text);
    expect(clean).not.toContain(fake);
    expect(clean).not.toContain("fake-bearer-only");
    expect(clean).not.toContain("fake-pass");
    expect(clean).toContain("[REDACTED]");
    expect(clean).toContain('const greeting = "hello";');
  });
  it("recursively redacts credential fields but preserves content and timestamps", () => {
    expect(
      sanitizeImportValue({
        content: "hello",
        input_tokens: 123,
        metadata: { access_token: "fake-only", ordinary: true },
      }),
    ).toEqual({
      content: "hello",
      input_tokens: 123,
      metadata: { access_token: "[REDACTED]", ordinary: true },
    });
  });
  it("redacts opaque credentials inside JSON-encoded tool arguments", () => {
    const original = {
      tool_calls: JSON.stringify([
        { arguments: JSON.stringify({ access_token: "opaque-fixture-only", query: "keep this" }) },
      ]),
    };
    const clean = sanitizeImportValue(original);
    expect(JSON.stringify(clean)).not.toContain("opaque-fixture-only");
    expect(JSON.stringify(clean)).toContain("keep this");
  });
  it("rejects cyclic or excessively nested metadata instead of silently truncating", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => sanitizeImportValue(circular)).toThrow();
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 45; depth++) nested = { child: nested };
    expect(() => sanitizeImportValue(nested)).toThrow();
  });
  it.each([
    ".env",
    ".env.local",
    ".git/config",
    "node_modules/x/index.js",
    "src/auth.json",
    ".ssh/id_rsa",
    "certs/key.pem",
    "state.db",
    ".npmrc",
    "config/credentials.json",
    "logs/run.log",
  ])("excludes credential/build/runtime path %s", (path) => {
    expect(isExcludedImportPath(path)).toBe(true);
  });
  it.each([
    ".env",
    "src/auth.json",
    ".ssh/id_rsa",
    "certs/key.pem",
    ".npmrc",
    "config/credentials.json",
  ])("allows sensitive path %s only with explicit opt-in", (path) => {
    expect(isExcludedImportPath(path, true)).toBe(false);
    expect(isExcludedImportPath(path)).toBe(true);
  });
  it.each(["../outside", "C:/outside", ".git/config", "node_modules/x/index.js", "state.db"])(
    "keeps filesystem/runtime safeguards for %s even after sensitive opt-in",
    (path) => {
      expect(isExcludedImportPath(path, true)).toBe(true);
    },
  );
  it.each([
    ".env.example",
    "src/main.ts",
    "scripts/run.py",
    "assets/logo.png",
    "SKILL.md",
    "references/help.md",
    "package.json",
    "src/token-counter.ts",
  ])("keeps portable source/skill path %s", (path) => {
    expect(isExcludedImportPath(path)).toBe(false);
  });
});
