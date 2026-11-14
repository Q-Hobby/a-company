# Desktop releases

## Windows ZIP: extract and run

The Windows x64 distribution is `A-Company-<version>-Windows-x64.zip`. Extract the
whole archive and open `A-Company.exe`; keep the adjacent files and `resources`
folder together. The built-in workspace requires no installer, separate Node.js,
PostgreSQL, or Docker installation. The ZIP is unsigned: Windows may warn or
block it according to system policy. Signing is deferred; do not disable security
controls to run it.

Build with `pnpm desktop:portable`. Output goes to `apps/desktop/out/portable/`,
separately from installer artifacts. The package metadata marks this distribution
as portable and disables the installer updater. Publish the ZIP and its SHA-256
checksum, never installer update-feed metadata. To update manually, quit the app,
extract the new release into a fresh folder, and launch its executable.

Data remains in `%APPDATA%/A-Company`, not beside the executable. Close the app
before backing up that entire directory, including its encryption material.
Deleting the extracted app does not delete workspace data. This is no-install
packaging, not a portable data profile.

## Standalone runtime and other deployment modes

The desktop includes the API, in-process job runner, and PGlite. The engine runs
in a separate child process using Electron's bundled Node runtime. Closing the
app waits for the database to stop. Packaged first launch starts this engine.
**Change A-Company Server…** opens built-in, Docker, and remote-server options.

The Lite CLI (`pnpm dev:lite`) and Docker Compose/server deployment remain
supported alongside the ZIP; they do not share its standalone database directory.
Cloud models need internet and a configured account or key. Optional local models
and CLI tools need their own configuration.

The accountless API rejects cross-origin browser mutations and non-loopback Host
headers before assigning its local actor. Same-origin requests and local JSON CLI
clients remain supported. This is a local trust boundary, not a multi-user network
server; use the authenticated Docker/server deployment for shared access.

`e2e/embedded.spec.ts` covers onboarding and persistence across quit. Run Electron
UI tests in CI's virtual display, not on a maintainer's desktop. macOS and Linux
packages need platform-specific verification and are not in the Windows release.

## Signed installer channel (optional, separate)

The `release-desktop` workflow builds, signs, notarizes, attests, and publishes
installers from a `vMAJOR.MINOR.PATCH` tag on `main` only when enabled through
`DESKTOP_SIGNING_ENABLED`, or explicitly dispatched. The unsigned ZIP is released
separately and must not replace signed installer update feeds. Docker image
publication remains a separate workflow triggered by release tags.

## Repository secrets

macOS (required):

| Secret | Value |
| --- | --- |
| `DESKTOP_MAC_CSC_LINK` | Base64 of the `Developer ID Application` certificate exported as `.p12` |
| `DESKTOP_MAC_CSC_KEY_PASSWORD` | Password used when exporting the `.p12` |
| `APPLE_API_KEY_ID` | App Store Connect API key ID (the `XXXXXXXXXX` in `AuthKey_XXXXXXXXXX.p8`) |
| `APPLE_API_ISSUER` | Issuer ID shown on App Store Connect > Users and Access > Integrations |
| `APPLE_API_KEY_P8` | Contents of the `AuthKey_*.p8` file |

The API key needs the Developer role. The workflow writes it to a mode 600 file
in the runner's temp directory for the packaging step and deletes it afterwards.

`patches/app-builder-lib@26.15.3.patch` carries electron-builder PR #10101:
without it `CSC_LINK` signing fails while creating the temporary keychain. Drop
the patch once an electron-builder release includes that fix.

Windows (optional):

| Secret | Value |
| --- | --- |
| `DESKTOP_WIN_CSC_LINK` | Base64 of the Authenticode certificate as `.p12`/`.pfx` |
| `DESKTOP_WIN_CSC_KEY_PASSWORD` | Its password |

When `DESKTOP_WIN_CSC_LINK` is unset the Windows build and its release assets
are skipped. macOS and Linux always build, and the release is only published
when every platform that was built produced its installer and update feed.

Set a secret from a file without echoing it:

```sh
base64 -i devid.p12 | gh secret set DESKTOP_MAC_CSC_LINK
gh secret set APPLE_API_KEY_P8 < AuthKey_XXXXXXXXXX.p8
```

## Cut a release

1. Bump `version` in `apps/desktop/package.json` on `main`.
2. Tag that commit `v<version>` and push the tag:

```sh
git tag v0.1.1
git push origin v0.1.1
```

The workflow refuses tags that do not match the desktop version, are not on
`main`, or are not newer than the latest published release.
