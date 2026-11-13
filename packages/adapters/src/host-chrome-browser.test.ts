import type { AdapterContext, ComputerRef } from "@acompany/adapter-kit";
import { describe, expect, it } from "vitest";
import { createBrowserProvider, resolveBrowserProviderKind } from "./browser-provider-factory.js";
import { resolveHostChromeCdpEndpoint, runHostChromePageBrowser } from "./host-chrome-browser.js";

describe("My Chrome host CDP bridge", () => {
  it("resolves host-chrome / my-chrome provider and default CDP endpoint", () => {
    expect(resolveBrowserProviderKind({ BROWSER_PROVIDER: "my-chrome" })).toBe("host-chrome");
    expect(resolveBrowserProviderKind({ BROWSER_PROVIDER: "host-chrome" })).toBe("host-chrome");
    expect(resolveHostChromeCdpEndpoint({})).toBe("http://127.0.0.1:9222");
    expect(resolveHostChromeCdpEndpoint({ ACOMPANY_HOST_CDP_PORT: "9333" })).toBe(
      "http://127.0.0.1:9333",
    );

    const provider = createBrowserProvider("my-chrome");
    expect(provider.describe().capabilities.page).toBe(true);
  });

  it("falls back cleanly to computer_act when host Chrome CDP is not reachable", async () => {
    const computer: ComputerRef = {
      id: "desktop-1",
      botId: "bot-1",
      kind: "desktop",
      providerRef: "/tmp/box",
    };
    const ctx: AdapterContext = {
      operationId: "op-1",
      traceId: "tr-1",
      spaceId: "sp-1",
      userId: "u-1",
      signal: new AbortController().signal,
    };
    const res = await runHostChromePageBrowser(computer, { command: "snapshot" }, ctx, {
      endpoint: "http://127.0.0.1:1",
    });
    expect(res.ok).toBe(false);
    expect(res.fallback).toBe("computer_act");
    expect(res.error).toContain("--remote-debugging-port=9222");
  });
});
