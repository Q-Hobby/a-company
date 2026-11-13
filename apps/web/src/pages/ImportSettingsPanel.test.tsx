// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  preview: vi.fn(),
  commit: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  export: vi.fn(),
  continue: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("../lib/rpc", () => ({ rpc: { imports: api } }));
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@acompany/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
}));

import { ImportSettingsPanel } from "./ImportSettingsPanel";

const preview = {
  projects: [{ id: "p1", source: "hermes", name: "Demo project", fileCount: 1 }],
  sessions: [{ id: "s1", source: "codex", title: "Demo session", messageCount: 2 }],
  skills: [
    { id: "k1", source: "hermes", name: "Demo skill", description: "A fixture", fileCount: 1 },
  ],
  sensitiveSources: [{ id: "auth", source: "hermes", name: "Hermes credentials", fileCount: null }],
  warnings: ["Fixture loss warning"],
};
const packet = { encoding: "gzip-base64", data: "fixture" };
const receipt = {
  id: "a".repeat(64),
  importedAt: "2026-01-01T00:00:00.000Z",
  projectCount: 0,
  sessionCount: 1,
  skillCount: 0,
  warnings: [],
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let popup: Window;
const fetcher = vi.fn();
const close = vi.fn();
function button(name: string) {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === name);
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function connect() {
  await click("Connect local");
  await act(async () =>
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://127.0.0.1:43123",
        source: popup,
        data: { type: "a-company-import-connected", capability: "b".repeat(64) },
      }),
    ),
  );
}
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  popup = { closed: false, close: vi.fn() } as unknown as Window;
  vi.spyOn(window, "open").mockReturnValue(popup);
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => (url.endsWith("/scan") ? { ...preview, sources: [] } : packet),
  }));
  api.list.mockResolvedValue([]);
  api.preview.mockResolvedValue(preview);
  api.commit.mockResolvedValue(receipt);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<ImportSettingsPanel onClose={close} />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("requires explicit selection, builds only selected data, previews before confirming", async () => {
  await connect();
  expect(
    [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(
      (c) => !c.checked,
    ),
  ).toBe(true);
  expect(button("Prepare selection").disabled).toBe(true);
  await act(async () =>
    (container.querySelector('input[aria-label="Demo session"]') as HTMLInputElement).click(),
  );
  await click("Prepare selection");
  expect(fetcher.mock.calls[1]?.[1].body).toBe(
    JSON.stringify({
      selection: {
        projectIds: [],
        sessionIds: ["s1"],
        skillIds: [],
        includeSensitiveData: false,
        sensitiveSourceIds: [],
      },
    }),
  );
  expect(api.preview).not.toHaveBeenCalled();
  await click("Upload for preview");
  expect(api.preview).toHaveBeenCalledWith({ packet }, expect.anything());
  expect(container.textContent).toContain("Fixture loss warning");
  expect(api.commit).not.toHaveBeenCalled();
  await click("Confirm import");
  expect(api.commit).toHaveBeenCalledWith(
    {
      packet,
      selection: {
        projectIds: [],
        sessionIds: ["s1"],
        skillIds: [],
        includeSensitiveData: false,
        sensitiveSourceIds: [],
      },
    },
    expect.anything(),
  );
  expect(container.textContent).toContain("Import complete");
  expect(
    [...container.querySelectorAll("button")].some((b) => b.textContent === "Confirm import"),
  ).toBe(false);
});

it("shows actionable fallback when the connection popup is blocked", async () => {
  vi.mocked(window.open).mockReturnValue(null);
  await click("Connect local");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("connect");
  expect(container.textContent).toContain("pnpm import:local");
  expect(container.textContent).toContain("import_local.bat");
  expect(button("Open import file").disabled).toBe(false);
});

it("shows unknown counts honestly and localizes stable warning codes", async () => {
  fetcher.mockResolvedValue({
    ok: true,
    json: async () => ({
      projects: [],
      sessions: [{ ...preview.sessions[0], messageCount: null }],
      skills: [{ ...preview.skills[0], fileCount: null }],
      warnings: ["FILES_OVER_LIMIT", "UNSUPPORTED_SOURCE_FORMAT", "SOURCE_UNAVAILABLE"],
      sources: [],
    }),
  });
  await connect();
  expect(container.textContent).not.toContain("null messages");
  expect(container.textContent).toContain("Not read yet");
  expect(container.textContent).not.toContain("FILES_OVER_LIMIT");
});

it("requires upload consent and fresh selection when opening a packet file", async () => {
  const file = { size: 100, text: async () => JSON.stringify(packet) };
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  expect(api.preview).not.toHaveBeenCalled();
  await click("Upload for preview");
  expect(api.preview).toHaveBeenCalledOnce();
  expect(button("Confirm import").disabled).toBe(true);
  expect(
    [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(
      (c) => !c.checked,
    ),
  ).toBe(true);
});

it("ignores a late scan response after cancellation", async () => {
  let resolve!: (value: unknown) => void;
  fetcher.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await connect();
  await click("Cancel");
  await act(async () => resolve({ ok: true, json: async () => ({ ...preview, sources: [] }) }));
  expect(container.textContent).not.toContain("Demo session");
  expect(button("Connect local").disabled).toBe(false);
});

it("inspects inert archived text and continues into a separate agent", async () => {
  api.list.mockResolvedValue([receipt]);
  api.get.mockResolvedValue({
    receipt,
    bundle: {
      version: 1,
      exportedAt: receipt.importedAt,
      projects: [],
      sessions: [
        {
          id: "s1",
          source: "codex",
          title: "Archived session",
          messages: [
            { id: "m1", role: "tool", content: '<img src=x onerror="alert(1)"> execute tool' },
          ],
        },
      ],
      skills: [
        {
          id: "k1",
          source: "hermes",
          name: "Archived skill",
          description: "Inactive",
          files: [{ path: "SKILL.md", contentBase64: btoa("<script>run()</script>") }],
        },
      ],
      warnings: [],
    },
  });
  api.continue.mockResolvedValue({ botId: "new-bot" });
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<ImportSettingsPanel onClose={close} />));
  await click("Inspect");
  expect(container.querySelector("img,script")).toBeNull();
  expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  expect(container.textContent).toContain("<script>run()</script>");
  await click("Continue session");
  expect(api.continue).toHaveBeenCalledWith({ id: receipt.id, sessionId: "s1" }, expect.anything());
  expect(navigate).toHaveBeenCalledWith("/app/new-bot");
  expect(close).toHaveBeenCalledOnce();
});

it("does not let a late initial archive list erase a completed import", async () => {
  let finishList!: (value: unknown[]) => void;
  api.list.mockReturnValueOnce(
    new Promise((resolve) => {
      finishList = resolve;
    }),
  );
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<ImportSettingsPanel onClose={close} />));
  await connect();
  await act(async () =>
    (container.querySelector('input[aria-label="Demo session"]') as HTMLInputElement).click(),
  );
  await click("Prepare selection");
  await click("Upload for preview");
  await click("Confirm import");
  await act(async () => finishList([]));
  expect(button("Inspect").disabled).toBe(false);
});

it("renders unknown warning text inertly even for object prototype names", async () => {
  fetcher.mockResolvedValue({
    ok: true,
    json: async () => ({
      ...preview,
      warnings: ["__proto__", "<img src=x onerror=run()>", "constructor"],
      sources: [],
    }),
  });
  await connect();
  expect(container.textContent).toContain("__proto__");
  expect(container.textContent).toContain("<img src=x onerror=run()>");
  expect(container.querySelector("img")).toBeNull();
});

async function toggle(name: string) {
  const input = container.querySelector(`input[aria-label="${name}"]`) as HTMLInputElement;
  if (!input) throw new Error(`Missing checkbox ${name}`);
  await act(async () => input.click());
}
async function openPacket(value: unknown) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [{ size: 100, text: async () => JSON.stringify(value) }],
  });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}

it("keeps sensitive sources hidden until opt-in and propagates consent only for selected groups", async () => {
  await connect();
  const consent = container.querySelector(
    'input[aria-label="Include sensitive data"]',
  ) as HTMLInputElement;
  expect(consent?.checked).toBe(false);
  expect(container.textContent).not.toContain("Hermes credentials");
  expect(container.textContent).not.toContain("may contain passwords");
  await toggle("Include sensitive data");
  expect(container.textContent).toContain("may contain passwords");
  expect(
    (container.querySelector('input[aria-label="Hermes credentials"]') as HTMLInputElement).checked,
  ).toBe(false);
  await toggle("Hermes credentials");
  await click("Prepare selection");
  expect(JSON.parse(fetcher.mock.calls[1]?.[1].body).selection).toEqual({
    projectIds: [],
    sessionIds: [],
    skillIds: [],
    includeSensitiveData: true,
    sensitiveSourceIds: ["auth"],
  });
  await click("Upload for preview");
  await click("Confirm import");
  expect(api.commit.mock.calls[0]?.[0].selection).toMatchObject({
    includeSensitiveData: true,
    sensitiveSourceIds: ["auth"],
  });
  await connect();
  expect(
    (container.querySelector('input[aria-label="Include sensitive data"]') as HTMLInputElement)
      .checked,
  ).toBe(false);
});

it("requires fresh file consent, never uploads a flagged packet by default, and invalidates preview on toggle", async () => {
  await openPacket({ ...packet, includeSensitiveData: true });
  expect(button("Upload for preview").disabled).toBe(true);
  await click("Upload for preview");
  expect(api.preview).not.toHaveBeenCalled();
  await toggle("Include sensitive data");
  await click("Upload for preview");
  expect(api.preview.mock.calls[0]?.[0].packet.includeSensitiveData).toBe(true);
  await toggle("Demo session");
  await toggle("Include sensitive data");
  expect(container.textContent).not.toContain("Confirm import");
  expect(button("Upload for preview").disabled).toBe(true);
  await openPacket({ ...packet, includeSensitiveData: true });
  expect(
    (container.querySelector('input[aria-label="Include sensitive data"]') as HTMLInputElement)
      .checked,
  ).toBe(false);
});

it("drops an in-flight sensitive bundle when consent is revoked", async () => {
  await connect();
  await toggle("Include sensitive data");
  await toggle("Hermes credentials");
  let finish!: (value: unknown) => void;
  fetcher.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await click("Prepare selection");
  await toggle("Include sensitive data");
  await act(async () =>
    finish({ ok: true, json: async () => ({ ...packet, includeSensitiveData: true }) }),
  );
  expect(container.textContent).not.toContain("Upload for preview");
  expect(container.textContent).not.toContain("Hermes credentials");
  expect(button("Prepare selection").disabled).toBe(true);
  expect(api.preview).not.toHaveBeenCalled();
});

it("blocks a consented sensitive packet on an insecure remote server before RPC", async () => {
  await openPacket({ ...packet, includeSensitiveData: true });
  await toggle("Include sensitive data");
  vi.stubGlobal("window", { location: { origin: "http://remote.example" } });
  await click("Upload for preview");
  expect(api.preview).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("requires HTTPS");
});

it("rebuilds safely after revoking consent and discards a late sensitive preview", async () => {
  await connect();
  await toggle("Demo session");
  await toggle("Include sensitive data");
  await toggle("Hermes credentials");
  await click("Prepare selection");
  let finish!: (value: unknown) => void;
  api.preview.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await click("Upload for preview");
  await toggle("Include sensitive data");
  await act(async () => finish(preview));
  expect(container.textContent).not.toContain("Confirm import");
  await click("Prepare selection");
  expect(JSON.parse(fetcher.mock.calls.at(-1)?.[1].body).selection).toEqual({
    projectIds: [],
    sessionIds: ["s1"],
    skillIds: [],
    includeSensitiveData: false,
    sensitiveSourceIds: [],
  });
  await click("Upload for preview");
  await click("Confirm import");
  expect(api.commit.mock.calls[0]?.[0].selection.includeSensitiveData).toBe(false);
});

it("continues an archived session with its explicitly imported project", async () => {
  api.list.mockResolvedValue([receipt]);
  api.get.mockResolvedValue({
    receipt,
    bundle: {
      version: 1,
      exportedAt: receipt.importedAt,
      warnings: [],
      projects: [{ id: "p1", source: "hermes", name: "Demo project", files: [] }],
      sessions: [
        { id: "s1", source: "codex", title: "Demo session", projectId: "p1", messages: [] },
      ],
      skills: [],
    },
  });
  api.continue.mockResolvedValue({ botId: "continued-fixture" });
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<ImportSettingsPanel onClose={close} />));
  await click("Inspect");
  await click("Continue session");
  expect(api.continue).toHaveBeenCalledWith(
    { id: receipt.id, sessionId: "s1", projectId: "p1" },
    expect.anything(),
  );
  expect(navigate).toHaveBeenCalledWith("/app/continued-fixture");
});

it("exports safely by default and requires a separate affirmative action for secrets", async () => {
  api.list.mockResolvedValue([{ ...receipt, includeSensitiveData: true, sensitiveFileCount: 2 }]);
  api.export.mockResolvedValue({ packet });
  const create = vi.fn().mockReturnValue("blob:fixture");
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<ImportSettingsPanel onClose={close} />));
  expect(container.textContent).toContain("2 sensitive files included");
  await click("Download");
  expect(api.export).toHaveBeenLastCalledWith(
    { id: receipt.id, includeSensitiveData: false },
    expect.anything(),
  );
  api.export.mockClear();
  await click("Export sensitive data");
  expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "contains secrets",
  );
  expect(api.export).not.toHaveBeenCalled();
  await click("Cancel export");
  expect(api.export).not.toHaveBeenCalled();
  await click("Export sensitive data");
  await click("Yes, export sensitive data");
  expect(api.export).toHaveBeenCalledExactlyOnceWith(
    { id: receipt.id, includeSensitiveData: true },
    expect.anything(),
  );
  expect(create).toHaveBeenCalledTimes(2);
});

it("never renders or logs credential file values or raw original fields", async () => {
  const value = "FAKE_PRIVATE_FIXTURE_NEVER_RENDER";
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const storage = vi.spyOn(Storage.prototype, "setItem");
  api.list.mockResolvedValue([{ ...receipt, includeSensitiveData: true, sensitiveFileCount: 1 }]);
  api.get.mockResolvedValue({
    receipt,
    bundle: {
      version: 1,
      exportedAt: receipt.importedAt,
      projects: [],
      skills: [],
      warnings: [],
      sessions: [
        {
          id: "s1",
          source: "codex",
          title: "Safe history",
          original: { token: value },
          messages: [{ id: "m1", role: "user", content: "[REDACTED]", original: value }],
        },
      ],
      sensitiveSources: [
        {
          id: "auth",
          source: "hermes",
          name: "Hermes credentials",
          files: [{ path: "auth.json", contentBase64: btoa(value) }],
        },
      ],
    },
  });
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<ImportSettingsPanel onClose={close} />));
  await click("Inspect");
  expect(container.textContent).not.toContain(value);
  expect(container.textContent).not.toContain(btoa(value));
  expect(container.textContent).not.toContain("auth.json");
  for (const spy of [log, warn, error, storage])
    expect(JSON.stringify(spy.mock.calls)).not.toContain(value);
});

it("cleans up the handshake when the panel unmounts", async () => {
  const remove = vi.spyOn(window, "removeEventListener");
  await click("Connect local");
  await act(async () => root.unmount());
  expect(remove).toHaveBeenCalledWith("message", expect.any(Function));
  expect(popup.close).toHaveBeenCalled();
});
