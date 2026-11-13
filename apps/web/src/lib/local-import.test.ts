// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  assertImportConsent,
  connectLocalImport,
  fetchLocalImport,
  readImportFile,
} from "./local-import";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("accepts a capability only from the exact helper origin and opened popup", async () => {
  const storage = { setItem: vi.fn() };
  vi.stubGlobal("localStorage", storage);
  const popup = { closed: false, close: vi.fn() } as unknown as Window;
  vi.spyOn(window, "open").mockReturnValue(popup);
  const controller = new AbortController();
  const result = connectLocalImport(controller.signal);
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  const data = { type: "a-company-import-connected", capability: "a".repeat(64) };
  window.dispatchEvent(
    new MessageEvent("message", { origin: "http://evil.example", source: popup, data }),
  );
  window.dispatchEvent(
    new MessageEvent("message", { origin: "http://127.0.0.1:43123", source: window, data }),
  );
  window.dispatchEvent(
    new MessageEvent("message", {
      origin: "http://127.0.0.1:43123",
      source: popup,
      data: { ...data, capability: "invalid" },
    }),
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  window.dispatchEvent(
    new MessageEvent("message", { origin: "http://127.0.0.1:43123", source: popup, data }),
  );
  await expect(result).resolves.toBe(data.capability);
  expect(window.open).toHaveBeenCalledWith(
    expect.stringContaining("/connect?origin="),
    expect.any(String),
    expect.any(String),
  );
  expect(storage.setItem).not.toHaveBeenCalled();
});

it("cleans up a pending handshake on abort", async () => {
  const storage = { setItem: vi.fn() };
  vi.stubGlobal("localStorage", storage);
  const popup = { closed: false, close: vi.fn() } as unknown as Window;
  vi.spyOn(window, "open").mockReturnValue(popup);
  const remove = vi.spyOn(window, "removeEventListener");
  const controller = new AbortController();
  const result = connectLocalImport(controller.signal);
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(remove).toHaveBeenCalledWith("message", expect.any(Function));
  expect(popup.close).toHaveBeenCalled();
});

it("reports blocked and closed popups without waiting forever", async () => {
  vi.spyOn(window, "open").mockReturnValue(null);
  await expect(connectLocalImport(new AbortController().signal)).rejects.toThrow("popup");
  vi.useFakeTimers();
  vi.mocked(window.open).mockReturnValue({ closed: true, close: vi.fn() } as unknown as Window);
  const result = connectLocalImport(new AbortController().signal);
  const assertion = expect(result).rejects.toThrow("closed");
  await vi.advanceTimersByTimeAsync(600);
  await assertion;
});

it("sends capabilities only in headers and refuses redirects and cookies", async () => {
  const fetcher = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ projects: [], sessions: [], skills: [], warnings: [], sources: [] }),
  });
  vi.stubGlobal("fetch", fetcher);
  await fetchLocalImport("scan", "b".repeat(64), new AbortController().signal);
  expect(fetcher).toHaveBeenCalledWith(
    "http://127.0.0.1:43123/scan",
    expect.objectContaining({
      redirect: "error",
      credentials: "omit",
      headers: expect.objectContaining({ Authorization: `Bearer ${"b".repeat(64)}` }),
    }),
  );
});

it("rejects credential selections without consent before contacting the helper", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    fetchLocalImport("bundle", "b".repeat(64), new AbortController().signal, {
      projectIds: [],
      sessionIds: [],
      skillIds: [],
      sensitiveSourceIds: ["auth"],
    }),
  ).rejects.toThrow("sensitive-consent-required");
  expect(fetcher).not.toHaveBeenCalled();
});

it("defaults bundle requests to explicit safe flags and preserves affirmative consent", async () => {
  const fetcher = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ encoding: "gzip-base64", data: "fixture" }),
  });
  vi.stubGlobal("fetch", fetcher);
  const base = { projectIds: [], sessionIds: [], skillIds: [] };
  await fetchLocalImport("bundle", "b".repeat(64), new AbortController().signal, base);
  expect(JSON.parse(fetcher.mock.calls[0]?.[1].body).selection).toEqual({
    ...base,
    includeSensitiveData: false,
    sensitiveSourceIds: [],
  });
  await fetchLocalImport("bundle", "b".repeat(64), new AbortController().signal, {
    ...base,
    includeSensitiveData: true,
    sensitiveSourceIds: ["auth"],
  });
  expect(JSON.parse(fetcher.mock.calls[1]?.[1].body).selection).toEqual({
    ...base,
    includeSensitiveData: true,
    sensitiveSourceIds: ["auth"],
  });
});

it("requires consent for flagged packets and TLS except exact loopback origins", () => {
  const packet = { encoding: "gzip-base64" as const, data: "fixture", includeSensitiveData: true };
  expect(() => assertImportConsent(packet, false, "https://remote.example")).toThrow(
    "sensitive-consent-required",
  );
  for (const origin of [
    "http://remote.example",
    "http://localhost.evil.test",
    "http://127.0.0.1.evil.test",
  ]) {
    expect(() => assertImportConsent(packet, true, origin)).toThrow("sensitive-https-required");
  }
  for (const origin of [
    "https://remote.example",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://[::1]:5173",
  ]) {
    expect(() => assertImportConsent(packet, true, origin)).not.toThrow();
  }
  expect(() =>
    assertImportConsent({ ...packet, includeSensitiveData: false }, false, "http://remote.example"),
  ).not.toThrow();
});

it("rejects sensitive helper reads on an insecure remote origin before fetch", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("window", { location: { origin: "http://remote.example" } });
  await expect(
    fetchLocalImport("bundle", "b".repeat(64), new AbortController().signal, {
      projectIds: [],
      sessionIds: [],
      skillIds: [],
      includeSensitiveData: true,
      sensitiveSourceIds: ["auth"],
    }),
  ).rejects.toThrow("sensitive-https-required");
  expect(fetcher).not.toHaveBeenCalled();
});

it("accepts the JSON envelope of a maximum-size exported packet", async () => {
  const packet = {
    encoding: "gzip-base64",
    data: "A".repeat(12 * 1024 * 1024),
    includeSensitiveData: true,
  };
  const encoded = JSON.stringify(packet);
  const result = await readImportFile({ size: encoded.length, text: async () => encoded } as File);
  expect(result.data.length).toBe(packet.data.length);
  expect(result.includeSensitiveData).toBe(true);
});

it("rejects oversized files before reading their contents", async () => {
  const text = vi.fn();
  await expect(readImportFile({ size: 13 * 1024 * 1024, text } as unknown as File)).rejects.toThrow(
    "large",
  );
  expect(text).not.toHaveBeenCalled();
});
