const { build } = require("./package.json");

module.exports = {
  ...build,
  directories: { ...build.directories, output: "out/portable" },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these macros.
  artifactName: "A-Company-${version}-Windows-${arch}.zip",
  extraMetadata: { ...build.extraMetadata, acompanyDistribution: "portable" },
  extraFiles: [
    { from: "../../LICENSE", to: "LICENSE-A-Company.txt" },
    { from: "portable-readme.txt", to: "START-HERE.txt" },
  ],
  win: { ...build.win, target: ["zip"] },
  publish: null,
};
