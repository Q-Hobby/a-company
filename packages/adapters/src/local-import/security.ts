import { isSafeImportPath } from "@acompany/contracts";

const REDACTED = "[REDACTED]";
const CREDENTIAL_FIELD =
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|passwd|authorization|cookie|credentials?|secret|token)$|[_-](?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)$/i;
const EXCLUDED_PARTS = new Set([
  ".git",
  "node_modules",
  ".pnpm",
  ".yarn",
  ".pnp",
  ".next",
  ".nuxt",
  ".turbo",
  ".expo",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "coverage",
  "dist",
  "build",
  "target",
  ".gradle",
  ".ssh",
  ".aws",
  ".azure",
  ".kube",
  ".gnupg",
  ".docker",
  ".hermes",
  ".codex",
  ".claude",
  ".antigravity",
  ".gemini",
  ".vscode",
  ".idea",
  "logs",
]);

const SENSITIVE_PARTS = new Set([
  ".ssh",
  ".aws",
  ".azure",
  ".kube",
  ".gnupg",
  ".docker",
  ".hermes",
  ".codex",
  ".claude",
  ".antigravity",
  ".gemini",
  ".vscode",
  ".idea",
]);

/** Data loss is surfaced in preview; a separate opt-in permits credential files, never unsafe paths. */
export function isExcludedImportPath(relative: string, includeSensitiveData = false): boolean {
  if (!isSafeImportPath(relative)) return true;
  const parts = relative.toLowerCase().split("/");
  if (
    parts.some(
      (part) => EXCLUDED_PARTS.has(part) && (!includeSensitiveData || !SENSITIVE_PARTS.has(part)),
    )
  )
    return true;
  const name = parts.at(-1) ?? "";
  if (includeSensitiveData) return /\.(?:sqlite|sqlite3|db|log|exe|dll|msi|dmp)$/i.test(name);
  if (/^\.env(?:\.|$)/.test(name) && !/^\.env\.(?:example|sample|template)$/.test(name))
    return true;
  if (/^(?:auth|credentials?|secrets?|tokens?)(?:\.|$)/.test(name)) return true;
  if ([".npmrc", ".pypirc", ".netrc", ".git-credentials", "id_rsa", "id_ed25519"].includes(name))
    return true;
  return /\.(?:pem|key|p12|pfx|keystore|sqlite|sqlite3|db|log|exe|dll|msi|dmp)$/i.test(name);
}

/** Best-effort detection, not a substitute for reviewing the selected data. */
export function redactImportText(text: string): string {
  return sanitizeImportValue(text) as string;
}

function redactPlainText(text: string): string {
  return text
    .replace(
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
      REDACTED,
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
      REDACTED,
    )
    .replace(/\bBearer\s+[^\s"',;&]+/gi, `Bearer ${REDACTED}`)
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, `$1${REDACTED}@`)
    .replace(
      /"([A-Za-z0-9_.-]+)"(\s*:\s*)"(?:\\.|[^"\\])*"/g,
      (whole, key: string, separator: string) =>
        CREDENTIAL_FIELD.test(key) ? `"${key}"${separator}"${REDACTED}"` : whole,
    )
    .replace(
      /\b([A-Za-z0-9_.-]+)(\s*[:=]\s*)(["'])([^\r\n]*?)\3/g,
      (whole, key: string, separator: string, quote: string) =>
        CREDENTIAL_FIELD.test(key) ? `${key}${separator}${quote}${REDACTED}${quote}` : whole,
    )
    .replace(
      /\b([A-Za-z0-9_.-]+)(\s*[:=]\s*)([^\s"',;]+)/g,
      (whole, key: string, separator: string, value: string) => {
        if (!CREDENTIAL_FIELD.test(key)) return whole;
        if (/^(?:process\.|os\.|env\.|\$|\[REDACTED\]|true$|false$|null$|undefined$)/i.test(value))
          return whole;
        return `${key}${separator}${REDACTED}`;
      },
    );
}

export function sanitizeImportValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  function visit(item: unknown, depth: number): unknown {
    if (depth > 40) throw new Error("Import metadata is too deeply nested.");
    if (typeof item === "string") {
      // Tool calls often store JSON inside JSON strings. Inspect those layers too.
      if (/^\s*[[{]/.test(item)) {
        try {
          const parsed: unknown = JSON.parse(item);
          const clean = visit(parsed, depth + 1);
          if (JSON.stringify(clean) !== JSON.stringify(parsed)) return JSON.stringify(clean);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      return redactPlainText(item);
    }
    if (typeof item === "bigint") return item.toString();
    if (item === null || typeof item !== "object") return item;
    if (seen.has(item)) throw new Error("Import metadata must not contain cycles.");
    seen.add(item);
    let result: unknown;
    if (Array.isArray(item)) {
      result = item.map((nested) => visit(nested, depth + 1));
    } else {
      result = Object.fromEntries(
        Object.entries(item).map(([key, nested]) => [
          key,
          CREDENTIAL_FIELD.test(key) ? REDACTED : visit(nested, depth + 1),
        ]),
      );
    }
    seen.delete(item);
    return result;
  }
  return visit(value, 0);
}
