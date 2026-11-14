// Verifies a packaged direct-download build (Windows ZIP or macOS app) with its own runtime:
//   ELECTRON_RUN_AS_NODE=1 <packaged executable> verify-direct-download.mjs <resources dir> <temp dir> <version>
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [resourcesPath, tempRoot, expectedVersion] = process.argv.slice(2);
assert.ok(resourcesPath && tempRoot && expectedVersion, "Pass resources dir, temp dir and version");
const appPath = path.join(resourcesPath, "app.asar");
const require = createRequire(path.join(appPath, "package.json"));
const metadata = require("./package.json");
assert.equal(metadata.acompanyDistribution, "portable");
assert.equal(metadata.version, expectedVersion);
const { initialUpdateState } = await import(
  pathToFileURL(path.join(appPath, "dist/auto-update.js")).href
);
assert.equal(
  initialUpdateState({ packaged: true, version: metadata.version, portable: true }).phase,
  "unsupported",
);
const sharp = require("sharp");
const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: "white" } })
  .png()
  .toBuffer();
assert.ok(png.length > 0);
assert.equal(typeof require("koffi").load, "function");

const { EmbeddedDesktopServer } = await import(
  pathToFileURL(path.join(appPath, "dist/embedded-server.js")).href
);
const userDataDir = await mkdtemp(path.join(tempRoot, "direct-download-profile-"));
const server = new EmbeddedDesktopServer({
  userDataDir,
  packaged: true,
  appPath,
  resourcesPath,
  imageTag: `v${expectedVersion}`,
});
const rpc = async (origin, procedure, json = {}) => {
  const response = await fetch(`${origin}/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ json }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).json;
};
try {
  const origin = await server.start();
  const capabilities = await (await fetch(`${origin}/api/auth/capabilities`)).json();
  assert.equal(capabilities.accountless, true);
  const page = await fetch(origin, { headers: { accept: "text/html" } });
  assert.equal(page.status, 200);
  const asset = (await page.text()).match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(asset);
  assert.equal((await fetch(new URL(asset, origin))).status, 200);
  assert.ok(await rpc(origin, "bootstrap"));
  const space = await rpc(origin, "spaces/create", { name: "Direct download verification" });
  assert.ok(space.id);
  for (const attacker of ["https://attacker.example", "null", "http://127.0.0.1:9999"]) {
    const rejected = await fetch(`${origin}/rpc/spaces/create`, {
      method: "POST",
      headers: { origin: attacker, "content-type": "text/plain" },
      body: JSON.stringify({ json: { name: "Rejected" } }),
    });
    assert.equal(rejected.status, 403);
  }
  const secretPath = path.join(userDataDir, "embedded/.embedded-secrets.json");
  const originalSecret = await readFile(secretPath, "utf8");
  await server.stop();
  await assert.rejects(fetch(`${origin}/health`));
  const next = await server.start();
  assert.ok(JSON.stringify(await rpc(next, "spaces/list")).includes(space.id));
  assert.equal(await readFile(secretPath, "utf8"), originalSecret);
  await server.stop();
  console.log(
    JSON.stringify({
      version: metadata.version,
      platform: `${process.platform}-${process.arch}`,
      updaterDisabled: true,
      nativeModules: true,
      renderer: true,
      crossOriginBlocked: true,
      persistedAfterRestart: true,
      encryptionKeyPreserved: true,
    }),
  );
} finally {
  await server.stop();
  await rm(userDataDir, { recursive: true, force: true });
}
