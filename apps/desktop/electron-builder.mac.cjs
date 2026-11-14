const { build } = require("./package.json");

// Direct-download macOS build: ad-hoc signed, not notarized, no update feed.
module.exports = {
  ...build,
  directories: { ...build.directories, output: "out/macos" },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these macros.
  artifactName: "A-Company-${version}-macOS-${arch}.${ext}",
  extraMetadata: { ...build.extraMetadata, acompanyDistribution: "portable" },
  mac: {
    ...build.mac,
    target: ["dmg"],
    identity: "-",
    hardenedRuntime: false,
    notarize: false,
  },
  publish: null,
};
