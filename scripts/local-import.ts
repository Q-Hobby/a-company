import {
  startLocalImportServer,
  validateLocalImportOrigin,
} from "../packages/adapters/src/local-import/server.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(
      "Usage: pnpm import:local [--app-origin <exact-origin>]\nRun on the source computer; approve only the popup opened by A-Company. Ctrl+C stops the helper.",
    );
    return;
  }
  let allowedOrigins: string[] | undefined;
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--app-origin" || !args[1])
      throw new Error("Usage: pnpm import:local [--app-origin <exact-origin>]");
    allowedOrigins = [validateLocalImportOrigin(args[1])];
  }
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 22))
    throw new Error(
      "Node >=22.22 required. Use import_local.bat or update Node, then run pnpm import:local.",
    );
  const server = await startLocalImportServer({ allowedOrigins });
  console.log("Local import helper: http://127.0.0.1:43123/health");
  console.log(
    "Open local import in A-Company, then click Allow in its popup. Nothing is scanned before approval. Ctrl+C stops the helper.",
  );
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  server.on("error", () => {
    console.error("Local import helper stopped. Close it and run pnpm import:local again.");
    stop();
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  // Never print raw runtime/provider errors, paths or source data.
  if (
    message === "Invalid app origin" ||
    message.startsWith("Usage: pnpm import:local") ||
    message.startsWith("Node >=22.22 required.")
  )
    console.error(message);
  else
    console.error(
      "Cannot start local import helper. Check Node >=22.22, installed dependencies and whether port 43123 is already in use.",
    );
  process.exitCode = 1;
});
