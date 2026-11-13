import type { ImportPacket, ImportSelection, LocalImportScan } from "@acompany/contracts";
import {
  ImportPacketSchema,
  LocalImportScanSchema,
  PORTABLE_IMPORT_MAX_PACKET_CHARS,
} from "@acompany/contracts";

export const LOCAL_IMPORT_ORIGIN = "http://127.0.0.1:43123";

/** Check before any network request; opaque flagged archives must never bypass consent. */
export function assertImportConsent(
  packet: Pick<ImportPacket, "includeSensitiveData">,
  consent: boolean,
  origin = window.location.origin,
) {
  if (!packet.includeSensitiveData) return;
  if (!consent) throw new Error("sensitive-consent-required");
  const url = new URL(origin);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("sensitive-https-required");
  }
}

/** The capability never leaves this caller's memory or an Authorization header. */
export function connectLocalImport(signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    let popup: Window | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      window.removeEventListener("message", receive);
      signal.removeEventListener("abort", abort);
      clearInterval(timer);
      try {
        popup?.close();
      } catch {
        /* A disconnected popup may already be gone. */
      }
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const receive = (event: MessageEvent) => {
      if (event.origin !== LOCAL_IMPORT_ORIGIN || !popup || event.source !== popup) return;
      const data: unknown = event.data;
      if (
        !data ||
        typeof data !== "object" ||
        !("type" in data) ||
        !("capability" in data) ||
        data.type !== "a-company-import-connected" ||
        typeof data.capability !== "string" ||
        !/^[a-f0-9]{64}$/.test(data.capability)
      )
        return;
      cleanup();
      resolve(data.capability);
    };
    window.addEventListener("message", receive);
    signal.addEventListener("abort", abort, { once: true });
    try {
      popup = window.open(
        `${LOCAL_IMPORT_ORIGIN}/connect?origin=${encodeURIComponent(window.location.origin)}`,
        "a-company-local-import",
        "popup,width=520,height=640",
      );
      if (!popup) {
        cleanup();
        reject(new Error("popup-blocked"));
        return;
      }
      const deadline = Date.now() + 120_000;
      timer = setInterval(() => {
        if (popup?.closed || Date.now() >= deadline) {
          cleanup();
          reject(new Error("popup-closed-or-timed-out"));
        }
      }, 500);
    } catch {
      cleanup();
      reject(new Error("popup-unavailable"));
    }
  });
}

export function fetchLocalImport(
  endpoint: "scan",
  capability: string,
  signal: AbortSignal,
): Promise<LocalImportScan>;
export function fetchLocalImport(
  endpoint: "bundle",
  capability: string,
  signal: AbortSignal,
  selection: ImportSelection,
): Promise<ImportPacket>;
export async function fetchLocalImport(
  endpoint: "scan" | "bundle",
  capability: string,
  signal: AbortSignal,
  selection?: ImportSelection,
) {
  if (!/^[a-f0-9]{64}$/.test(capability)) throw new Error("invalid-capability");
  if (endpoint === "bundle") {
    if (!selection) throw new Error("selection-required");
    if (selection.sensitiveSourceIds?.length && !selection.includeSensitiveData) {
      throw new Error("sensitive-consent-required");
    }
    selection = {
      ...selection,
      includeSensitiveData: selection.includeSensitiveData === true,
      sensitiveSourceIds: selection.sensitiveSourceIds ?? [],
    };
    assertImportConsent(selection, selection.includeSensitiveData === true);
  }
  const response = await fetch(`${LOCAL_IMPORT_ORIGIN}/${endpoint}`, {
    method: endpoint === "scan" ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${capability}`,
      ...(endpoint === "bundle" ? { "Content-Type": "application/json" } : {}),
    },
    body: endpoint === "bundle" ? JSON.stringify({ selection }) : undefined,
    credentials: "omit",
    redirect: "error",
    signal,
  });
  if (!response.ok) throw new Error("local-helper-unavailable");
  const value: unknown = await response.json();
  return endpoint === "scan" ? LocalImportScanSchema.parse(value) : ImportPacketSchema.parse(value);
}

export async function readImportFile(file: File): Promise<ImportPacket> {
  if (file.size > PORTABLE_IMPORT_MAX_PACKET_CHARS + 1024) throw new Error("file-too-large");
  return ImportPacketSchema.parse(JSON.parse(await file.text()));
}

export function downloadImportPacket(packet: ImportPacket, id: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(packet)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${id}.a-company-import.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function importFileText(contentBase64: string): string {
  try {
    const bytes = Uint8Array.from(atob(contentBase64), (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "";
  }
}
