import type {
  ImportPacket,
  ImportPreview,
  ImportReceipt,
  ImportSelection,
  PortableImportBundle,
  StarterTeamSummary,
  WorkspaceSnapshot,
} from "@acompany/contracts";
import { Button } from "@acompany/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  assertImportConsent,
  connectLocalImport,
  downloadImportPacket,
  fetchLocalImport,
  importFileText,
  readImportFile,
} from "../lib/local-import";
import { rpc } from "../lib/rpc";

const emptySelection = (): ImportSelection => ({
  projectIds: [],
  sessionIds: [],
  skillIds: [],
  includeSensitiveData: false,
  sensitiveSourceIds: [],
});
type Archive = { receipt: ImportReceipt; bundle: PortableImportBundle };
type Stage = "idle" | "scan" | "packet" | "preview";

function ImportWarnings({ warnings }: { warnings: string[] }) {
  const { t } = useLingui();
  const labels: Record<string, string> = {
    RUNTIME_NOT_IMPORTED: t`Runtime settings are not imported.`,
    SENSITIVE_DATA_INCLUDED_INACTIVE: t`Sensitive data is stored encrypted and inactive.`,
    ATTACHMENTS_NOT_IMPORTED: t`Attachments are not imported.`,
    SKILLS_ARCHIVED_INACTIVE: t`Skills are archived, not activated.`,
    GIT_HISTORY_EXCLUDED: t`Git history is excluded.`,
    PROJECT_FILES_EXCLUDED: t`Some project files are excluded.`,
    SYMLINKS_EXCLUDED: t`Symbolic links are excluded.`,
    KNOWN_SECRETS_REDACTED: t`Known secrets were redacted. Review the selection before uploading.`,
    SCAN_LIMIT_REACHED: t`Scan limit reached. Some items may be missing.`,
    PROJECT_NOT_SELECTED: t`The session's project is not selected.`,
    FILES_OVER_LIMIT: t`Files exceeding the import limit are excluded.`,
    UNSUPPORTED_SOURCE_FORMAT: t`Some source formats are not supported.`,
    SOURCE_UNAVAILABLE: t`Some source data is unavailable.`,
  };
  if (!warnings.length) return null;
  return (
    <details className="rounded-lg border border-border p-3 text-sm">
      <summary className="cursor-pointer font-medium">{t`Warnings and omissions`}</summary>
      <ul className="mt-2 list-disc space-y-1 ps-5 text-muted-foreground">
        {[...new Set(warnings)].map((warning) => (
          <li className="break-words" key={warning}>
            {Object.hasOwn(labels, warning) ? labels[warning] : warning}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ImportSettingsPanel({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>("idle");
  const [metadata, setMetadata] = useState<ImportPreview | null>(null);
  const [packet, setPacket] = useState<ImportPacket | null>(null);
  const [selection, setSelection] = useState<ImportSelection>(emptySelection);
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [helperUnavailable, setHelperUnavailable] = useState(false);
  const [receipts, setReceipts] = useState<ImportReceipt[]>([]);
  const [archive, setArchive] = useState<Archive | null>(null);
  const [completed, setCompleted] = useState(false);
  const [archiveError, setArchiveError] = useState(false);
  const [fileSensitive, setFileSensitive] = useState(false);
  const [sensitiveExport, setSensitiveExport] = useState<string | null>(null);
  const sourceFile = useRef<File | null>(null);
  const localScan = useRef<ImportPreview | null>(null);
  const capability = useRef<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const upload = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void rpc.imports
      .list({}, { signal: controller.signal })
      .then((list) => {
        if (!controller.signal.aborted) {
          setReceipts((current) => [
            ...current,
            ...list.filter((item) => !current.some((existing) => existing.id === item.id)),
          ]);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setArchiveError(true);
      });
    return () => {
      mounted.current = false;
      controller.abort();
      operation.current?.abort();
      capability.current = null;
    };
  }, []);

  async function run(task: (signal: AbortSignal) => Promise<void>, local = false) {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError("");
    try {
      await task(controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) {
        const code = cause instanceof Error ? cause.message : "";
        if (code === "sensitive-consent-required" || code === "sensitive-https-required") {
          setError(
            code === "sensitive-consent-required"
              ? t`Choose Include sensitive data before uploading this file.`
              : t`Sensitive data requires HTTPS or a loopback server.`,
          );
          return;
        }
        setError(
          local
            ? t`Could not connect to the local helper. Allow popups, start the helper, then try again.`
            : t`Import failed. Check the file or connection and try again.`,
        );
        if (local) {
          setHelperUnavailable(true);
          capability.current = null;
        }
      }
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }
  function cancel() {
    operation.current?.abort();
    operation.current = null;
    capability.current = null;
    setBusy(false);
    setPacket(null);
    setMetadata(null);
    setSelection(emptySelection());
    sourceFile.current = null;
    localScan.current = null;
    setFileSensitive(false);
    setStage("idle");
    setError("");
  }
  function connect() {
    void run(async (signal) => {
      sourceFile.current = null;
      localScan.current = null;
      setFileSensitive(false);
      setCompleted(false);
      setPacket(null);
      setMetadata(null);
      setSelection(emptySelection());
      setStage("idle");
      const token = await connectLocalImport(signal);
      if (signal.aborted) return;
      capability.current = token;
      const scan = await fetchLocalImport("scan", token, signal);
      if (signal.aborted) return;
      localScan.current = scan;
      setMetadata(scan);
      setStage("scan");
      setHelperUnavailable(false);
    }, true);
  }
  function prepare() {
    void run(async (signal) => {
      if (!capability.current) throw new Error("not-connected");
      const built = await fetchLocalImport("bundle", capability.current, signal, selection);
      if (signal.aborted) return;
      setPacket(built);
      setStage("packet");
    }, true);
  }
  function openFile(file: File) {
    void run(async (signal) => {
      setSelection(emptySelection());
      setPacket(null);
      setMetadata(null);
      localScan.current = null;
      sourceFile.current = file;
      const loaded = await readImportFile(file);
      if (signal.aborted) return;
      capability.current = null;
      setPacket(loaded);
      setFileSensitive(loaded.includeSensitiveData === true);
      setMetadata(null);
      setSelection(emptySelection());
      setStage("packet");
      setCompleted(false);
    });
  }
  function changeConsent(enabled: boolean) {
    operation.current?.abort();
    operation.current = null;
    setBusy(false);
    setError("");
    setPacket(null);
    setSelection((current) => ({
      ...current,
      includeSensitiveData: enabled,
      sensitiveSourceIds: [],
    }));
    setMetadata(localScan.current);
    setStage(sourceFile.current ? "packet" : localScan.current ? "scan" : "idle");
  }
  function preview() {
    if (!packet && !sourceFile.current) return;
    void run(async (signal) => {
      const pending = packet ?? (await readImportFile(sourceFile.current!));
      if (signal.aborted) return;
      assertImportConsent(pending, selection.includeSensitiveData === true);
      const result = await rpc.imports.preview({ packet: pending }, { signal });
      if (signal.aborted) return;
      setPacket(pending);
      // A local selection is retained only for IDs actually returned by the server.
      setSelection((current) => ({
        includeSensitiveData: current.includeSensitiveData === true,
        sensitiveSourceIds: current.includeSensitiveData
          ? (current.sensitiveSourceIds ?? []).filter((id) =>
              result.sensitiveSources?.some((item) => item.id === id),
            )
          : [],
        projectIds: current.projectIds.filter((id) =>
          result.projects.some((item) => item.id === id),
        ),
        sessionIds: current.sessionIds.filter((id) =>
          result.sessions.some((item) => item.id === id),
        ),
        skillIds: current.skillIds.filter((id) => result.skills.some((item) => item.id === id)),
      }));
      setMetadata(result);
      setStage("preview");
    });
  }
  function commit() {
    if (!packet) return;
    void run(async (signal) => {
      assertImportConsent(packet, selection.includeSensitiveData === true);
      const receipt = await rpc.imports.commit({ packet, selection }, { signal });
      if (signal.aborted) return;
      setReceipts((current) => [receipt, ...current.filter((item) => item.id !== receipt.id)]);
      setCompleted(true);
      setStage("idle");
      setPacket(null);
      setMetadata(null);
      setSelection(emptySelection());
      sourceFile.current = null;
      localScan.current = null;
      capability.current = null;
    });
  }
  function inspect(id: string) {
    void run(async (signal) => {
      const result = await rpc.imports.get({ id }, { signal });
      if (!signal.aborted) setArchive(result);
    });
  }
  function download(id: string, includeSensitiveData = false) {
    setSensitiveExport(null);
    void run(async (signal) => {
      const result = await rpc.imports.export({ id, includeSensitiveData }, { signal });
      if (!signal.aborted) downloadImportPacket(result.packet, id);
    });
  }
  function continueImport(id: string, target: { sessionId: string } | { projectId: string }) {
    const linkedProjectId =
      "sessionId" in target && archive?.receipt.id === id
        ? archive.bundle.sessions.find((session) => session.id === target.sessionId)?.projectId
        : undefined;
    const approvedProjectId =
      linkedProjectId && archive?.bundle.projects.some((project) => project.id === linkedProjectId)
        ? linkedProjectId
        : undefined;
    void run(async (signal) => {
      const result = await rpc.imports.continue(
        { id, ...target, ...(approvedProjectId ? { projectId: approvedProjectId } : {}) },
        { signal },
      );
      if (signal.aborted) return;
      // Shell already refreshes the roster on focus and routes bots at /app/:id.
      window.dispatchEvent(new Event("focus"));
      navigate(`/app/${encodeURIComponent(result.botId)}`);
      onClose();
    });
  }
  const selectedCount =
    selection.projectIds.length +
    selection.sessionIds.length +
    selection.skillIds.length +
    (selection.sensitiveSourceIds?.length ?? 0);
  const groups = metadata
    ? [
        {
          key: "projectIds" as const,
          label: t`Projects`,
          items: metadata.projects.map((item) => ({
            ...item,
            label: item.name,
            count: item.fileCount === null ? t`Not read yet` : t`${item.fileCount} files`,
          })),
        },
        {
          key: "sessionIds" as const,
          label: t`Sessions`,
          items: metadata.sessions.map((item) => ({
            ...item,
            label: item.title || t`Untitled session`,
            count: item.messageCount === null ? t`Not read yet` : t`${item.messageCount} messages`,
          })),
        },
        {
          key: "skillIds" as const,
          label: t`Skills`,
          items: metadata.skills.map((item) => ({
            ...item,
            label: item.name,
            count: item.fileCount === null ? t`Not read yet` : t`${item.fileCount} files`,
          })),
        },
        ...(selection.includeSensitiveData
          ? [
              {
                key: "sensitiveSourceIds" as const,
                label: t`Credential sources`,
                items: (metadata.sensitiveSources ?? []).map((item) => ({
                  ...item,
                  label: item.name,
                  count: item.fileCount === null ? t`Not read yet` : t`${item.fileCount} files`,
                })),
              },
            ]
          : []),
      ]
    : [];
  const fileDetails = (files: PortableImportBundle["skills"][number]["files"]) =>
    files.map((file) => (
      <details key={file.path} className="mt-2">
        <summary className="cursor-pointer break-all text-sm">{file.path}</summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">
          {importFileText(file.contentBase64) || t`Binary or unreadable file`}
        </pre>
      </details>
    ));

  return (
    <section className="space-y-5" aria-label={t`Import data`} aria-busy={busy}>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={connect}>{t`Connect local`}</Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => upload.current?.click()}
        >{t`Open import file`}</Button>
        <input
          ref={upload}
          type="file"
          className="hidden"
          accept=".a-company-import.json,application/json"
          aria-label={t`Import file`}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) openFile(file);
          }}
        />
        {busy ? <Button variant="outline" onClick={cancel}>{t`Cancel`}</Button> : null}
      </div>
      {busy ? <p role="status" className="text-sm text-muted-foreground">{t`Working…`}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {helperUnavailable ? (
        <div className="space-y-2 rounded-lg border border-border p-3 text-sm text-muted-foreground">
          <p>{t`Start the helper on this computer, then reconnect:`}</p>
          <code className="select-all">{`pnpm import:local --app-origin ${JSON.stringify(window.location.origin)}`}</code>
          <p>{t`On Windows, you can also run import_local.bat. Or open an exported .a-company-import.json file.`}</p>
        </div>
      ) : null}
      {completed ? <p role="status" className="text-sm">{t`Import complete`}</p> : null}
      {stage !== "idle" ? (
        <div className="space-y-2 text-sm">
          <label className="flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              aria-label={t`Include sensitive data`}
              checked={selection.includeSensitiveData === true}
              onChange={(event) => changeConsent(event.target.checked)}
            />
            {t`Include sensitive data`}
          </label>
          {selection.includeSensitiveData ? (
            <p className="text-muted-foreground">{t`Selected data may contain passwords, keys, tokens, or .env files. It is stored encrypted and inactive, never used to sign in or continue chats.`}</p>
          ) : null}
          {fileSensitive && !selection.includeSensitiveData ? (
            <p
              role="status"
              className="text-muted-foreground"
            >{t`Choose Include sensitive data before uploading this file.`}</p>
          ) : null}
        </div>
      ) : null}
      {stage === "packet" ? (
        <div className="space-y-3 rounded-lg border border-border p-4">
          <p className="text-sm text-muted-foreground">{t`Upload the selected content to this A-Company server for preview? Nothing is imported yet.`}</p>
          <div className="flex gap-2">
            <Button
              disabled={busy || (fileSensitive && !selection.includeSensitiveData)}
              onClick={preview}
            >{t`Upload for preview`}</Button>
            <Button variant="outline" disabled={busy} onClick={cancel}>{t`Discard`}</Button>
          </div>
        </div>
      ) : null}
      {metadata && (stage === "scan" || stage === "preview") ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="text-sm">
              {t`Source`}{" "}
              <select
                className="rounded-md border border-input bg-background p-2"
                value={filter}
                disabled={busy}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option value="all">{t`All sources`}</option>
                <option value="hermes">{t`Hermes`}</option>
                <option value="codex">{t`Codex`}</option>
              </select>
            </label>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                setSelection((current) => {
                  const next = { ...current };
                  for (const group of groups)
                    next[group.key] = [
                      ...new Set([
                        ...(current[group.key] ?? []),
                        ...group.items
                          .filter((item) => filter === "all" || item.source === filter)
                          .map((item) => item.id),
                      ]),
                    ];
                  return next;
                })
              }
            >{t`Select visible`}</Button>
            <Button
              variant="ghost"
              disabled={busy || !selectedCount}
              onClick={() =>
                setSelection((current) => ({
                  ...emptySelection(),
                  includeSensitiveData: current.includeSensitiveData === true,
                }))
              }
            >{t`Clear selection`}</Button>
          </div>
          {groups.map((group) => (
            <fieldset
              key={group.key}
              disabled={busy}
              className="min-w-0 rounded-lg border border-border px-3 pb-2"
            >
              <legend className="px-1 text-sm font-medium">{group.label}</legend>
              {group.items
                .filter((item) => filter === "all" || item.source === filter)
                .map((item) => (
                  <label
                    key={item.id}
                    className="flex min-h-11 cursor-pointer items-start gap-3 py-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="mt-1 size-4 accent-primary"
                      aria-label={item.label}
                      checked={(selection[group.key] ?? []).includes(item.id)}
                      onChange={(event) =>
                        setSelection((current) => ({
                          ...current,
                          [group.key]: event.target.checked
                            ? [...(current[group.key] ?? []), item.id]
                            : (current[group.key] ?? []).filter((id) => id !== item.id),
                        }))
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words">{item.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {item.source === "hermes" ? t`Hermes` : t`Codex`} · {item.count}
                      </span>
                    </span>
                  </label>
                ))}
            </fieldset>
          ))}
          <ImportWarnings warnings={metadata.warnings} />
          {stage === "preview" ? (
            <p className="text-sm text-muted-foreground">{t`History stays in the archive. Skills and tool calls are not executed.`}</p>
          ) : null}
          <div className="sticky bottom-0 z-10 border-t border-border bg-background py-3">
            <Button disabled={busy || !selectedCount} onClick={stage === "scan" ? prepare : commit}>
              {stage === "scan" ? t`Prepare selection` : t`Confirm import`}
            </Button>
          </div>
        </div>
      ) : null}
      <div className="space-y-3 border-t border-border pt-4">
        <h3 className="text-sm font-medium">{t`Imported archives`}</h3>
        {archiveError ? (
          <p
            role="alert"
            className="text-sm text-destructive"
          >{t`Could not load archives. Reopen settings to retry.`}</p>
        ) : null}
        {!receipts.length && !archiveError ? (
          <p className="text-sm text-muted-foreground">{t`No imports yet`}</p>
        ) : null}
        {receipts.map((receipt) => (
          <div
            key={receipt.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"
          >
            <span className="text-sm">
              <time dateTime={receipt.importedAt}>
                {new Date(receipt.importedAt).toLocaleString()}
              </time>
              <span className="block text-xs text-muted-foreground">{t`${receipt.projectCount} projects · ${receipt.sessionCount} sessions · ${receipt.skillCount} skills`}</span>
              {receipt.includeSensitiveData ? (
                <span className="block text-xs text-muted-foreground">{t`${receipt.sensitiveFileCount ?? 0} sensitive files included`}</span>
              ) : null}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => inspect(receipt.id)}
              >{t`Inspect`}</Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => download(receipt.id)}
              >{t`Download`}</Button>
              {receipt.includeSensitiveData ? (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setSensitiveExport(receipt.id)}
                >{t`Export sensitive data`}</Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {sensitiveExport ? (
        <div
          role="alertdialog"
          aria-label={t`Export sensitive data`}
          aria-describedby="sensitive-export-warning"
          className="space-y-3 rounded-lg border border-border p-4"
        >
          <p
            id="sensitive-export-warning"
            className="text-sm"
          >{t`This file contains secrets in plaintext. Store it securely and do not share it.`}</p>
          <div className="flex gap-2">
            <Button
              disabled={busy}
              onClick={() => download(sensitiveExport, true)}
            >{t`Yes, export sensitive data`}</Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setSensitiveExport(null)}
            >{t`Cancel export`}</Button>
          </div>
        </div>
      ) : null}
      {archive ? (
        <div className="space-y-3 rounded-lg border border-border p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{t`Archive contents`}</h3>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setArchive(null)}
            >{t`Close archive`}</Button>
          </div>
          <p className="text-sm text-muted-foreground">{t`Read-only history. Continue creates a new agent; the archive stays unchanged.`}</p>
          {archive.receipt.includeSensitiveData ? (
            <p className="text-sm text-muted-foreground">{t`${archive.receipt.sensitiveFileCount ?? 0} sensitive files included`}</p>
          ) : null}
          <ImportWarnings warnings={[...archive.receipt.warnings, ...archive.bundle.warnings]} />
          {archive.bundle.sessions.map((session) => (
            <details key={session.id} className="rounded-lg border border-border p-3">
              <summary className="cursor-pointer break-words text-sm">
                {session.title || t`Untitled session`}
              </summary>
              <Button
                className="mt-3"
                variant="outline"
                disabled={busy}
                onClick={() => continueImport(archive.receipt.id, { sessionId: session.id })}
              >{t`Continue session`}</Button>
              {session.messages.map((message, index) => (
                <div key={`${message.id}-${index}`} className="mt-3">
                  <p className="text-xs text-muted-foreground">{message.role}</p>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">
                    {message.content}
                  </pre>
                </div>
              ))}
            </details>
          ))}
          {archive.bundle.projects.map((project) => (
            <details key={project.id} className="rounded-lg border border-border p-3">
              <summary className="cursor-pointer break-words text-sm">{project.name}</summary>
              <Button
                className="mt-3"
                variant="outline"
                disabled={busy}
                onClick={() => continueImport(archive.receipt.id, { projectId: project.id })}
              >{t`Continue project`}</Button>
              {fileDetails(project.files)}
            </details>
          ))}
          {archive.bundle.skills.map((skill) => (
            <details key={skill.id} className="rounded-lg border border-border p-3">
              <summary className="cursor-pointer break-words text-sm">{skill.name}</summary>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                {skill.description}
              </p>
              {fileDetails(skill.files)}
            </details>
          ))}
        </div>
      ) : null}
      <TeamBlueprintsAndBackupCard onClose={onClose} />
    </section>
  );
}

function downloadTextBlob(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function pickLocalFile(accept: string, onPick: (file: File) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) onPick(file);
  };
  input.click();
}

function TeamBlueprintsAndBackupCard({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [starters, setStarters] = useState<StarterTeamSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    let active = true;
    void rpc.blueprints
      ?.listStarters?.()
      ?.then((items) => {
        if (active) setStarters(items);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  async function applyStarter(slug: string) {
    setBusy(true);
    setErr("");
    setNotice("");
    try {
      const res = await rpc.blueprints.applyStarter({ slug });
      const firstId = res.botIds[0];
      if (firstId) {
        navigate(`/app/${encodeURIComponent(firstId)}`);
        onClose();
        return;
      }
      setNotice(t`Created ${res.createdBots} bots.`);
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : t`Failed to apply starter team.`);
    } finally {
      setBusy(false);
    }
  }

  async function exportBlueprint() {
    setBusy(true);
    setErr("");
    setNotice("");
    try {
      const res = await rpc.blueprints.exportMarkdown();
      downloadTextBlob(res.filename, res.markdown, "text/markdown;charset=utf-8");
      setNotice(t`Exported ${res.filename} (secrets redacted).`);
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : t`Failed to export blueprint.`);
    } finally {
      setBusy(false);
    }
  }

  async function importBlueprintFile(file: File) {
    setBusy(true);
    setErr("");
    setNotice("");
    try {
      const markdown = await file.text();
      const res = await rpc.blueprints.importMarkdown({ markdown });
      const firstId = res.botIds[0];
      if (firstId) {
        navigate(`/app/${encodeURIComponent(firstId)}`);
        onClose();
        return;
      }
      setNotice(t`Imported ${res.createdBots} bots.`);
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : t`Invalid blueprint Markdown file.`);
    } finally {
      setBusy(false);
    }
  }

  async function exportSnapshot() {
    setBusy(true);
    setErr("");
    setNotice("");
    try {
      const snap = await rpc.export.workspaceSnapshot();
      const slug =
        snap.spaceName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "workspace";
      const filename = `${slug}-backup.json`;
      downloadTextBlob(filename, JSON.stringify(snap, null, 2), "application/json;charset=utf-8");
      setNotice(t`Downloaded ${filename}.`);
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : t`Failed to export workspace backup.`);
    } finally {
      setBusy(false);
    }
  }

  async function restoreSnapshotFile(file: File) {
    setBusy(true);
    setErr("");
    setNotice("");
    try {
      const raw = JSON.parse(await file.text()) as WorkspaceSnapshot;
      const res = await rpc.export.restoreWorkspaceSnapshot({ snapshot: raw });
      setNotice(t`Restored ${res.createdBots} bots and ${res.restoredSkills} skills.`);
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : t`Invalid workspace backup file.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="team-blueprints-card"
      className="rounded-xl border border-border px-4 py-4 space-y-4"
    >
      <div>
        <h3 className="text-[15px] font-medium text-foreground">{t`Team Blueprints & Backup`}</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void exportBlueprint()}
          >
            {t`Export Team (.md)`}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              pickLocalFile(".md,text/markdown,text/plain", (f) => void importBlueprintFile(f))
            }
          >
            {t`Import Team (.md)`}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void exportSnapshot()}>
            {t`Backup Workspace (.json)`}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              pickLocalFile(".json,application/json", (f) => void restoreSnapshotFile(f))
            }
          >
            {t`Restore Backup`}
          </Button>
        </div>
      </div>

      {starters.length > 0 ? (
        <div className="space-y-2 border-t border-border pt-3">
          <div className="text-[13px] font-medium text-foreground">{t`Starter Teams`}</div>
          <div className="grid gap-2 sm:grid-cols-3">
            {starters.map((starter) => (
              <div
                key={starter.slug}
                className="flex flex-col justify-between rounded-lg border border-border p-3 text-[12.5px]"
              >
                <div>
                  <div className="font-medium text-foreground">{starter.label}</div>
                  <p className="mt-1 text-muted-foreground">{starter.description}</p>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  className="mt-3 self-start"
                  disabled={busy}
                  onClick={() => void applyStarter(starter.slug)}
                >
                  {starter.botCount === 1 ? t`Add 1 bot` : t`Add ${starter.botCount} bots`}
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {notice ? <p className="text-[12.5px] text-muted-foreground">{notice}</p> : null}
      {err ? <p className="text-[12.5px] text-destructive">{err}</p> : null}
    </div>
  );
}
