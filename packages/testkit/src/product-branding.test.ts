import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const sourceRoots = ["apps", "packages", "infra", "scripts", "docs", ".github", ".agents"];
const textExtension =
  /\.(?:ts|tsx|js|mjs|cjs|json|html|astro|svg|po|webmanifest|md|yml|yaml|sh|ps1|py|kt|xml|gradle|sql)$/;
// Assemble retired identifiers via char codes so this test file itself stays 100% free of them.
const retiredName = String.fromCharCode(114, 97, 107, 97, 122, 111);
const retiredOrg = String.fromCharCode(103, 101, 116, 105, 110, 98, 111, 120, 122, 101, 114, 111);
const retiredLegal = String.fromCharCode(
  105,
  110,
  98,
  111,
  120,
  32,
  122,
  101,
  114,
  111,
  32,
  105,
  110,
  99,
);
const retiredPattern = new RegExp(`${retiredName}|${retiredOrg}|${retiredLegal}`, "i");

function sourceFiles(directory: string): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === ".turbo" ||
      entry.name === ".expo" ||
      entry.name === "build" ||
      entry.name === "out"
    ) {
      return [];
    }
    const relative = `${directory}/${entry.name}`;
    if (retiredPattern.test(entry.name)) {
      return [relative];
    }
    if (entry.isDirectory()) return sourceFiles(relative);
    return textExtension.test(entry.name) ? [relative] : [];
  });
}

describe("product branding", () => {
  it("uses A-Company and acompany native identities across every application surface", () => {
    const desktop = JSON.parse(readFileSync(path.join(root, "apps/desktop/package.json"), "utf8"));
    const mobile = JSON.parse(readFileSync(path.join(root, "apps/mobile/app.json"), "utf8"));
    const web = JSON.parse(
      readFileSync(path.join(root, "apps/web/public/site.webmanifest"), "utf8"),
    );
    const website = JSON.parse(
      readFileSync(path.join(root, "apps/www/public/site.webmanifest"), "utf8"),
    );
    expect([desktop.productName, mobile.expo.name, web.name, website.name]).toEqual(
      Array(4).fill("A-Company"),
    );
    expect(desktop.build.appId).toBe("dev.acompany.desktop");
    expect(mobile.expo.scheme).toBe("acompany");
    expect(mobile.expo.ios.bundleIdentifier).toBe("com.acompany.app");
    expect(mobile.expo.android.package).toBe("com.acompany.app");
  });

  it("keeps the retired brand completely out of source, infra, scripts, workflows, and docs", () => {
    const remaining: string[] = [];
    for (const file of sourceRoots.flatMap(sourceFiles)) {
      if (retiredPattern.test(file)) {
        remaining.push(`${file}:filename`);
        continue;
      }
      const lines = readFileSync(path.join(root, file), "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        if (retiredPattern.test(line)) remaining.push(`${file}:${index + 1}`);
      }
    }
    expect(remaining).toEqual([]);
  });
});
