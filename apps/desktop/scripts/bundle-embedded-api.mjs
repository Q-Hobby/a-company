import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "dist/embedded-api.mjs");

// Inline jsdom's default-stylesheet.css so the bundled runtime never depends on
// relative filesystem lookups outside app.asar.
const inlineJsdomAssetsPlugin = {
  name: "inline-jsdom-assets",
  setup(b) {
    b.onLoad({ filter: /computed-style\.js$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const cssPath = path.resolve(
        path.dirname(args.path),
        "../../../browser/default-stylesheet.css",
      );
      const css = await readFile(cssPath, "utf8");
      const patched = source.replace(
        /fs\.readFileSync\(\s*path\.resolve\(__dirname,\s*["']\.\.\/\.\.\/\.\.\/browser\/default-stylesheet\.css["']\)[\s\S]*?\)/,
        JSON.stringify(css),
      );
      return { contents: patched, loader: "js" };
    });
    // Rewrite css-tree's runtime createRequire(...) JSON loads into static ESM JSON imports
    // so esbuild bundles the JSON data directly into embedded-api.mjs.
    b.onLoad({ filter: /css-tree[/\\]lib[/\\](data-patch|data|version)\.js$/ }, async (args) => {
      let source = await readFile(args.path, "utf8");
      source = source
        .replace(/import\s*\{\s*createRequire\s*\}\s*from\s*['"]module['"];?/g, "")
        .replace(/const\s+require\s*=\s*createRequire\(import\.meta\.url\);?/g, "");
      const imports = [];
      let idx = 0;
      source = source.replace(/require\((['"][^'"]+\.json['"])\)/g, (_m, spec) => {
        const ident = `__cssTreeJson${++idx}`;
        imports.push(`import ${ident} from ${spec};`);
        return ident;
      });
      return { contents: `${imports.join("\n")}\n${source}`, loader: "js" };
    });
    // Replace jsdom's top-level require.resolve("./xhr-sync-worker.js") with an inert string.
    b.onLoad({ filter: /XMLHttpRequest-impl\.js$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const patched = source.replace(/require\.resolve\(["']\.\/xhr-sync-worker\.js["']\)/g, '""');
      return { contents: patched, loader: "js" };
    });
  },
};

await build({
  stdin: {
    contents: `
      export { serve } from "@hono/node-server";
      export { createApp } from "../api/src/app.ts";
    `,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile,
  plugins: [inlineJsdomAssetsPlugin],
  external: ["@electric-sql/pglite", "koffi", "sharp", "electron", "fsevents"],
  banner: {
    js: 'import { createRequire as __acompanyCreateRequire } from "node:module"; const require = __acompanyCreateRequire(import.meta.url);',
  },
  logLevel: "warning",
});

const built = await readFile(outfile, "utf8");
if (built.includes("default-stylesheet.css")) {
  throw new Error("Failed to inline jsdom default-stylesheet.css in embedded-api.mjs");
}
