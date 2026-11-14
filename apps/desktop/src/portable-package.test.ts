import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { DesktopUpdateController, initialUpdateState } from "./auto-update.js";

const require = createRequire(import.meta.url);

describe("Direct-download distributions", () => {
  it("declares its bundled backend as a build dependency for Turbo ordering and caching", () => {
    const manifest = require("../package.json");
    expect(manifest.devDependencies["@acompany/api"]).toBe("workspace:*");
  });

  it("packages a ZIP separately from signed installers and their update feeds", () => {
    const config = require("../electron-builder.portable.cjs");
    expect(config.win.target).toEqual(["zip"]);
    expect(config.directories.output).toBe("out/portable");
    expect(config.extraMetadata.acompanyDistribution).toBe("portable");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: assert electron-builder's unexpanded macros.
    expect(config.artifactName).toBe("A-Company-${version}-Windows-${arch}.zip");
    expect(config.publish).toBeNull();
    expect(config.extraResources.some((entry: { to: string }) => entry.to === "web")).toBe(true);
    expect(config.extraResources.some((entry: { to: string }) => entry.to === "migrations")).toBe(
      true,
    );
  });

  it("packages an ad-hoc signed macOS DMG without notarization or update feeds", () => {
    const config = require("../electron-builder.mac.cjs");
    expect(config.mac.target).toEqual(["dmg"]);
    expect(config.mac.identity).toBe("-");
    expect(config.mac.hardenedRuntime).toBe(false);
    expect(config.mac.notarize).toBe(false);
    expect(config.directories.output).toBe("out/macos");
    expect(config.extraMetadata.acompanyDistribution).toBe("portable");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: assert electron-builder's unexpanded macros.
    expect(config.artifactName).toBe("A-Company-${version}-macOS-${arch}.${ext}");
    expect(config.publish).toBeNull();
  });

  it("never loads or contacts the installer updater in portable builds", async () => {
    const state = initialUpdateState({ packaged: true, version: "0.2.2", portable: true });
    expect(state.phase).toBe("unsupported");
    expect(state.message).toContain("latest release");
    let loaded = false;
    const controller = new DesktopUpdateController(
      { packaged: true, version: "0.2.2", portable: true },
      async () => {
        loaded = true;
        throw new Error("Portable builds must not load the installer updater");
      },
    );
    await controller.check(false);
    await controller.check(true);
    expect(loaded).toBe(false);
  });
});
