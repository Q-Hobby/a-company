# Local import: Hermes and Codex

Run the helper **on the computer holding the source data**, not inside Docker:

```sh
pnpm import:local
```

On Windows, run `import_local.bat` from the repository (it also works from another working directory). It uses Node >=22.22 with `node:sqlite`, falling back to an existing compatible runtime under `%LOCALAPPDATA%\hermes\tools\node-*-win32-x64`. Install repository dependencies with `pnpm install` first; the launcher never downloads a runtime or package. Neither entry point opens browser tabs automatically.

The helper binds only `127.0.0.1:43123`. Its static health endpoint is `http://127.0.0.1:43123/health`. Open local import in A-Company, inspect the exact app origin shown in its popup, and click **Allow** only if you initiated it. No source scan runs on startup, health checks, or opening the approval page. After approval, scan lists source summaries; bundle reads the selected content. Stop the helper with Ctrl+C when finished.

Default approved app origins are exactly `http://127.0.0.1:5173` and `http://localhost:5173`. For another app deployment, explicitly replace this list:

```sh
pnpm import:local --app-origin https://app.example
# Windows: import_local.bat --app-origin http://localhost:8000
```

Use an exact origin, without trailing slash, path, query, fragment or credentials. HTTP is accepted only for `127.0.0.1`, `localhost`, or `[::1]`; other origins require HTTPS. No remote app is trusted by default. Browser local-network permission, popup policy, or organization restrictions may still block access; do not expose the helper on the LAN to work around them. A Docker-hosted app still needs this separate helper running on the source computer: a container cannot access the browser computer's local files.

## Supported source layouts

- Hermes: `HERMES_HOME`, `~/.hermes`, and on Windows `~/AppData/Local/hermes`; existing `profiles/<name>` under those roots are discovered read-only. Known `state.db` session/message tables and `skills/**/SKILL.md` are supported. The helper does not switch or modify profiles.
- Codex: `CODEX_HOME` or `~/.codex`; known `sessions` / `archived_sessions` JSONL records, optional `session_index.jsonl` titles, and `skills/**/SKILL.md`.
- Projects are directories referenced by supported session metadata, not an arbitrary whole-disk search. Unknown layouts, unavailable files, and unsupported source versions produce warnings rather than a promise of complete migration. Unknown counts remain unknown until content is collected.

The imported archive is an **independent copy**, not a live link or a full backup. Source projects, sessions and profiles are never modified. Imported skills and credential containers are archived **inactive**, not automatically installed, executed or used to sign in. Native runtime continuation is unsupported: imports do not restore running agents, tool processes or native thread identity. OAuth credentials may be expired or bound to the original application/device; copying them is not a promise of a working sign-in. Attachments outside the supported records are not copied.

## Exclusions and limits

Sensitive-data transfer is a **per-import user decision**, off by default. Without approval, project/skill credential files and private `.env` files are excluded, and recognizable secret text/credential fields are redacted best-effort. With explicit approval, selected project/session/skill content is preserved without that redaction, and the user can separately select detected credential containers: Hermes `.env`, `auth.json`, `config.yaml`, `credentials.json`; Codex `auth.json`, `config.toml`. Discovery lists names/counts only, never credential values, and does not read credential contents. Approval to scan is not approval to transfer credentials.

Included sensitive originals must be encrypted at rest in A-Company and remain inactive. Ordinary archive views, continuation and default export use a safe/redacted projection. Exporting originals requires a separate explicit sensitive-export confirmation; that downloaded file contains secrets and must be protected. Never put sensitive import packets on an unencrypted remote HTTP connection; loopback HTTP is supported for the local helper/app. Secret redaction cannot guarantee arbitrary private content is removed, so review the selection before sending it to an app, especially a remote deployment.

Filesystem safety is separate from this choice: `.git` history, dependencies/build/cache directories, runtime stores, logs, databases and executable binaries remain excluded; symlinks, hard links and unsafe portable paths remain rejected or excluded. Example/sample/template `.env` files may remain in ordinary source imports. No real credential values belong in repository fixtures, logs, screenshots or public reports.

Fixed MVP limits:

- HTTP selection body: 512 KiB; approval form: 1 KiB; request headers: 8 KiB; URL: 2048 characters.
- Scan response: 2 MiB. Bundle packet data: 12 MiB of base64 characters; HTTP envelope allowance: 1 KiB. Unpacked bundle: 64 MiB; individual project/skill file: 2 MiB.
- Selection/bundle: 100 projects, 1000 sessions, 1000 skills; at most 20,000 messages/records per session. Codex session files: 32 MiB. Traversal and file-count limits can exclude large trees with warnings or require a smaller selection.
- One scan/bundle operation at a time, no waiting queue; at most 32 TCP connections, 32 pending approvals and 32 active capabilities. Connect and approval requests each allow 20 attempts per minute. Requests time out after 10 seconds, headers after 5 seconds; retry a smaller selection if necessary.

Approval nonces last five minutes and are single-use. In-memory capabilities last 30 minutes and are bound to the exact approved app origin. They travel only in the popup's targeted `postMessage`, then as bearer headers—not URLs, cookies or disk files. Shutdown revokes them. Scan/bundle require both the capability and matching browser Origin even on loopback. Responses are no-store, errors are generic, and there are no permissive wildcard CORS headers.
