# Changelog

All notable changes to **A-Company** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-11-13

### Added

- **Zero-Docker Lite Mode (`pnpm dev:lite`):** Run the full A-Company stack locally with embedded PostgreSQL (**PGlite** via `DATABASE_URL=pglite`), automatic Prisma migration execution, and local workspace sandboxes — no Docker or external PostgreSQL server required.
- **Zero-Cost Local CLI Model Providers:** Native adapters for **Claude Code** (`claude-cli`), **OpenAI Codex** (`codex-cli`), **Google Gemini CLI** (`gemini-cli`), and **OpenCode** (`opencode-cli`) so users can reuse existing local subscriptions without per-token API keys.
- **My Chrome Live CDP Bridge (`BROWSER_PROVIDER=my-chrome`):** Let local bots automate tabs in an already-signed-in desktop Chrome session over Chrome DevTools Protocol (`--remote-debugging-port=9222`), with automatic fallback when unavailable.
- **One-Click Starter Teams & Portable Markdown Blueprints:** Spin up curated multi-agent teams (**Engineering Squad**, **Research & Content**, **Personal Ops**) in one click, and import/export version-controllable `.md` Team Blueprints with automatic credential redaction.
- **Workspace Snapshot Backup & Restore:** Full `.json` workspace export and import under **Settings → Import data** with strict secret stripping.
- **Token Spend Caps & Usage Telemetry:** Daily and monthly UTC token budgets (`usage/updateBudget`) that guard new runs before overspending, paired with per-bot and per-model usage breakdowns in **Settings → Usage**.
- **Interactive Chat Mini-Apps (`render_widget`):** Bots can render sandboxed inline HTML/CSS/SVG dashboards, calculators, and status widgets directly in chat threads with full-screen expansion.
- **Inbound Bot Webhooks:** Per-bot `POST /api/v1/bots/:botId/webhook` endpoint with Bearer secret generation/rotation and ready-to-copy `curl` examples in **Bot Settings → Advanced**.
- **Headless CLI & Stdio MCP Server:** Scriptable `scripts/acompany-cli.ts` and Model Context Protocol server (`scripts/mcp-server.ts`) for driving bots and blueprints from Claude Desktop, Cursor, or CI pipelines.
- **Cross-Platform Installers:** Added Windows PowerShell self-host installer (`infra/compose/install-images.ps1`) alongside the Linux/macOS Bash installer.
- **Voice Mode & Messaging Channels:** Spoken replies, hold-to-talk dictation, and live calls (ElevenLabs, OpenAI, Cartesia, Fish Audio), plus Slack, WhatsApp Business Cloud, Telegram, and iMessage/SMS bot connectors.

### Changed

- Unified 100% of the monorepo under the **Apache License 2.0** and the `@acompany/*` package namespace across Web, Electron Desktop (`dev.acompany.desktop`), and Expo Mobile (`com.acompany.app`).
- Refreshed all product documentation, OpenGraph cards, walkthrough video, and high-DPI screenshots directly from the live A-Company runtime.
- Renamed lazy MCP catalog tool wrappers to `connectors_search_tools`, `connectors_load_tool`, and `connectors_execute_tool` for full compatibility with Anthropic OAuth sessions.

## [0.1.0-beta] - 2026-08-13

- Initial beta architecture across Web, Electron Desktop, and Expo Mobile backed by Hono, oRPC, Prisma, Better Auth, Graphile Worker, Pi runtime, and containerized computer sandboxes.
