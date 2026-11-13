import { describe, expect, it } from "vitest";
import {
  ImportSelectionSchema,
  isSafeImportPath,
  LocalImportScanSchema,
  PortableImportBundleSchema,
} from "./portable-import.js";

describe("portable import contracts", () => {
  it.each([
    "../outside",
    "a/../outside",
    "/absolute",
    "C:/absolute",
    "a\\b",
    "file:stream",
    "a//b",
    "./file",
    "CON",
    "a/NUL.txt",
    "file.",
    "file ",
    "a/\u0000bad",
    "src/file?.ts",
    "src/file*.ts",
    "a/COM¹.txt",
    "CONIN$",
    "CONOUT$",
  ])("rejects nonportable path %s", (value) => {
    expect(isSafeImportPath(value)).toBe(false);
  });
  it.each([
    "src/main.ts",
    "assets/logo.png",
    "SKILL.md",
    "references/hướng-dẫn.md",
    ".env.example",
    "a-b/c_d",
  ])("accepts relative portable path %s", (value) => {
    expect(isSafeImportPath(value)).toBe(true);
  });
  it("requires a versioned portable bundle", () => {
    expect(
      PortableImportBundleSchema.safeParse({
        version: 2,
        exportedAt: "2026-01-01T00:00:00.000Z",
        projects: [],
        sessions: [],
        skills: [],
        warnings: [],
      }).success,
    ).toBe(false);
  });
  it("allows unknown counts only in discovery summaries", () => {
    expect(
      LocalImportScanSchema.parse({
        sources: [],
        projects: [{ id: "p", source: "hermes", name: "Example", fileCount: null }],
        sessions: [],
        skills: [],
        warnings: [],
      }).projects[0]?.fileCount,
    ).toBeNull();
    expect(
      ImportSelectionSchema.safeParse({
        projectIds: [],
        sessionIds: [],
        skillIds: [],
        arbitraryHostPath: "C:/",
      }).data,
    ).toEqual({ projectIds: [], sessionIds: [], skillIds: [] });
  });
});
