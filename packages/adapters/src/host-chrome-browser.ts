import type {
  AdapterContext,
  BrowserSnapshotNode,
  ComputerRef,
  PageBrowserCommand,
  PageBrowserResult,
} from "@acompany/adapter-kit";

const WORLD_NAME = "acompany-host-chrome-bridge";

const EVAL_HELPERS = `
(() => {
  if (window.__acompanyHostPageBrowser) return true;
  const refMap = new Map();
  function newRef() {
    return "e" + Array.from(crypto.getRandomValues(new Uint32Array(2)), n => n.toString(16).padStart(8, "0")).join("");
  }
  function visible(el) {
    if (!(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "submit" || type === "button") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    if (tag === "textarea" || el.isContentEditable) return "textbox";
    if (tag === "select") return "combobox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    return tag;
  }
  function nameOf(el) {
    return (
      el.getAttribute("aria-label") ||
      Array.from(el.labels || []).map(l => l.textContent).join(" ").trim() ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      el.getAttribute("title") ||
      (el.innerText || el.textContent || "").trim().slice(0, 80) ||
      ""
    );
  }
  function isInteractive(el) {
    if (!(el instanceof Element)) return false;
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "input", "textarea", "select", "summary"].includes(tag)) return true;
    if (el.isContentEditable) return true;
    const role = el.getAttribute("role");
    if (role && ["button", "link", "textbox", "checkbox", "radio", "menuitem", "tab", "option", "switch"].includes(role)) {
      return true;
    }
    return typeof el.onclick === "function" || el.hasAttribute("tabindex");
  }
  function formatTree(elements) {
    if (!elements.length) return "(no interactive elements)";
    return elements
      .map(el => {
        const value = el.value !== undefined && el.value !== "" ? " value=" + JSON.stringify(el.value) : "";
        return "- " + el.role + " \\"" + el.name + "\\" [" + el.ref + "]" + value;
      })
      .join("\\n");
  }
  window.__acompanyHostPageBrowser = {
    snapshot() {
      refMap.clear();
      const elements = [];
      for (const el of document.querySelectorAll("body *")) {
        if (!isInteractive(el) || !visible(el)) continue;
        const ref = newRef();
        refMap.set(ref, el);
        elements.push({
          ref,
          role: roleOf(el),
          name: String(nameOf(el)).slice(0, 200),
          value: el.type === "password" ? undefined
            : ["checkbox", "radio"].includes(el.type) ? (el.checked ? "checked" : "unchecked")
            : "value" in el ? String(el.value ?? "").slice(0, 2000) : undefined,
          tag: el.tagName.toLowerCase(),
        });
        if (elements.length >= 80) break;
      }
      return {
        url: location.href,
        title: (document.title || "").slice(0, 200),
        elements,
        tree: (document.body?.innerText || "").slice(0, 12000) + "\\n" + formatTree(elements),
      };
    },
    resolve(ref) {
      const el = refMap.get(String(ref));
      if (!el || !el.isConnected || !visible(el)) return null;
      if (el.matches(":disabled") || el.getAttribute("aria-disabled") === "true") {
        throw new Error("Element is disabled");
      }
      return el;
    },
    click(ref) {
      const el = this.resolve(ref);
      if (!el) throw new Error("Unknown element ref: " + ref);
      el.focus();
      el.click();
      return { url: location.href, title: (document.title || "").slice(0, 200) };
    },
    fill(ref, value) {
      const el = this.resolve(ref);
      if (!el) throw new Error("Unknown element ref: " + ref);
      if (el.readOnly) throw new Error("Element is read-only");
      el.focus();
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        const prototype = el instanceof HTMLInputElement ? HTMLInputElement.prototype
          : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value").set.call(el, String(value));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = String(value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        throw new Error("Element is not fillable: " + ref);
      }
      return { url: location.href, title: (document.title || "").slice(0, 200) };
    },
    type(ref, text) {
      const el = this.resolve(ref);
      if (!el) throw new Error("Unknown element ref: " + ref);
      const current = "value" in el ? el.value : (el.textContent || "");
      return this.fill(ref, String(current) + String(text));
    },
  };
  return true;
})()
`;

interface CdpTargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export function resolveHostChromeCdpEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ACOMPANY_HOST_CDP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const port = Number(env.ACOMPANY_HOST_CDP_PORT ?? "9222");
  const safePort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : 9222;
  return `http://127.0.0.1:${safePort}`;
}

class MinimalCdpSocket {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (res: Record<string, unknown>) => void; reject: (err: Error) => void }
  >();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      try {
        const msg = JSON.parse(raw) as {
          id?: number;
          result?: Record<string, unknown>;
          error?: { message?: string };
        };
        if (typeof msg.id === "number") {
          const waiter = this.pending.get(msg.id);
          if (waiter) {
            this.pending.delete(msg.id);
            if (msg.error) {
              waiter.reject(new Error(msg.error.message || "CDP error"));
            } else {
              waiter.resolve(msg.result ?? {});
            }
          }
        }
      } catch {
        // Ignore malformed CDP notifications
      }
    });
    ws.addEventListener("close", () => {
      for (const [, waiter] of this.pending) {
        waiter.reject(new Error("CDP WebSocket closed"));
      }
      this.pending.clear();
    });
  }

  static async connect(wsUrl: string, signal?: AbortSignal): Promise<MinimalCdpSocket> {
    return await new Promise<MinimalCdpSocket>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const onAbort = () => {
        ws.close();
        reject(new Error("Aborted connecting to host Chrome CDP"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      ws.addEventListener(
        "open",
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(new MinimalCdpSocket(ws));
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          signal?.removeEventListener("abort", onAbort);
          reject(new Error(`Unable to connect to Chrome WebSocket at ${wsUrl}`));
        },
        { once: true },
      );
    });
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

async function selectActivePageWsUrl(baseHttpUrl: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${baseHttpUrl}/json/list`, { signal });
  if (!res.ok) {
    throw new Error(`Host Chrome CDP returned HTTP ${res.status}`);
  }
  const targets = (await res.json()) as CdpTargetInfo[];
  const page =
    targets.find(
      (t) =>
        t.type === "page" &&
        t.webSocketDebuggerUrl &&
        !t.url.startsWith("devtools://") &&
        !t.url.startsWith("chrome-extension://"),
    ) ?? targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) {
    const created = await fetch(`${baseHttpUrl}/json/new?about:blank`, {
      method: "PUT",
      signal,
    });
    if (created.ok) {
      const target = (await created.json()) as CdpTargetInfo;
      if (target.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
    }
    throw new Error("No attachable tab found in host Chrome");
  }
  return page.webSocketDebuggerUrl;
}

async function evaluateInWorld<T>(
  cdp: MinimalCdpSocket,
  contextId: number,
  expression: string,
): Promise<T> {
  const res = await cdp.send("Runtime.evaluate", {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    const details = res.exceptionDetails as {
      text?: string;
      exception?: { description?: string };
    };
    throw new Error(details.exception?.description || details.text || "Browser evaluate failed");
  }
  const result = res.result as { value?: T } | undefined;
  return result?.value as T;
}

export async function runHostChromePageBrowser(
  _computer: ComputerRef,
  request: PageBrowserCommand,
  context: AdapterContext,
  options: { endpoint?: string } = {},
): Promise<PageBrowserResult> {
  const endpoint = options.endpoint ?? resolveHostChromeCdpEndpoint();
  let cdp: MinimalCdpSocket | null = null;
  try {
    const wsUrl = await selectActivePageWsUrl(endpoint, context.signal);
    cdp = await MinimalCdpSocket.connect(wsUrl, context.signal);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    if (request.command === "navigate") {
      const parsed = new URL(request.url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return {
          ok: false,
          fallback: "computer_act",
          error: "Only http/https URLs are supported on My Chrome bridge",
        };
      }
      await cdp.send("Page.navigate", { url: request.url });
      await new Promise((r) => setTimeout(r, 450));
    }

    const frameTree = (await cdp.send("Page.getFrameTree")) as {
      frameTree?: { frame?: { id?: string } };
    };
    const frameId = frameTree.frameTree?.frame?.id;
    if (!frameId) {
      throw new Error("Unable to locate active Chrome frame");
    }
    const world = (await cdp.send("Page.createIsolatedWorld", {
      frameId,
      worldName: WORLD_NAME,
      grantUniveralAccess: true,
    })) as { executionContextId?: number };
    const contextId = world.executionContextId;
    if (typeof contextId !== "number") {
      throw new Error("Unable to create isolated world in Chrome tab");
    }

    await evaluateInWorld(cdp, contextId, EVAL_HELPERS);

    if (request.command === "navigate") {
      const snap = await evaluateInWorld<{
        url: string;
        title: string;
      }>(cdp, contextId, "window.__acompanyHostPageBrowser.snapshot()");
      return {
        ok: true,
        url: snap.url,
        title: snap.title,
      };
    }

    if (request.command === "snapshot") {
      const snap = await evaluateInWorld<{
        url: string;
        title: string;
        tree: string;
        elements: BrowserSnapshotNode[];
      }>(cdp, contextId, "window.__acompanyHostPageBrowser.snapshot()");
      return {
        ok: true,
        url: snap.url,
        title: snap.title,
        tree: snap.tree,
        elements: snap.elements,
      };
    }

    let completed = 0;
    for (const step of request.actions) {
      if (step.kind === "click") {
        await evaluateInWorld(
          cdp,
          contextId,
          `window.__acompanyHostPageBrowser.click(${JSON.stringify(step.ref)})`,
        );
      } else if (step.kind === "fill") {
        await evaluateInWorld(
          cdp,
          contextId,
          `window.__acompanyHostPageBrowser.fill(${JSON.stringify(step.ref)}, ${JSON.stringify(step.text)})`,
        );
      } else {
        await evaluateInWorld(
          cdp,
          contextId,
          `window.__acompanyHostPageBrowser.type(${JSON.stringify(step.ref)}, ${JSON.stringify(step.text)})`,
        );
      }
      completed += 1;
    }
    const after = await evaluateInWorld<{
      url: string;
      title: string;
      tree: string;
      elements: BrowserSnapshotNode[];
    }>(cdp, contextId, "window.__acompanyHostPageBrowser.snapshot()");
    return {
      ok: true,
      completed,
      url: after.url,
      title: after.title,
      tree: after.tree,
      elements: after.elements,
    };
  } catch (error) {
    return {
      ok: false,
      fallback: "computer_act",
      uncertain: false,
      error:
        error instanceof Error
          ? `My Chrome bridge (${endpoint}) unavailable: ${error.message}. Launch Chrome with --remote-debugging-port=9222 to share your logged-in browser.`
          : "My Chrome bridge unavailable",
    };
  } finally {
    cdp?.close();
  }
}
