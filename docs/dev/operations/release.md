# Releasing NEXT HMI

Internal checklist for cutting a new release. Read [deploy.md](deploy.md) for
operator-facing install instructions.

## Versioning

Pick a semver-ish tag (`0.x.y`). The version string ends up in:

- `build/_vendor/version.txt` — embedded in the PyInstaller bundle.
- The `version.txt` file shipped at the top of the binary zip.
- The launcher banner (`NEXT HMI 0.x.y`).
- Optionally the Docker image tag.

The build scripts accept the version via a positional argument
(`./build/build-binary.sh 0.3.1`) or the `NEXTHMI_VERSION` env var.

## Pre-flight

From a clean checkout on the release branch:

```bash
# Backend
source .venv/bin/activate
pytest backend/tests
ruff check backend

# Frontend
cd frontend
npm test
npm run lint
npm run format:check
npm run build
cd ..
```

All four suites must be green. The frontend build doubles as a
TypeScript check.

### License-signing key

If this is an `ee` release, verify that `_PUBLIC_KEY_HEX` in
`license.py` is the production verify key. Both `license.py` and the
issuer, `generate_license.py`, live in the private `nexthmi-enterprise`
repository (cloned into the gitignored `enterprise/` directory for `ee`
builds), not in this repository. Its private half
(`license-signing-PROD.key`) never leaves the offline issuing machine.
There is no env-var override, deliberately: an override would let a
process swap the trust root and self-sign.

## Docker

The Docker artifact is a self-contained zip — image tarball + compose +
`install.sh` — built by `build/build-docker.sh`, the Docker analogue of
`build-binary.sh`. End users unzip and run `./install.sh`; no registry or
source checkout required.

```bash
# from repo root, Docker on PATH; single-arch per host
./build/build-docker.sh 0.x.y
```

Output: `dist/nexthmi-docker-linux-<arch>.zip`, containing
`nexthmi-image.tar.gz` (a gzipped `docker save`), a self-contained
`docker-compose.yml` (no `build:`, no registry), `install.sh`,
`version.txt`, and `README.txt`.

Smoke-test from a clean unzip, exactly as an operator would:

```bash
unzip dist/nexthmi-docker-linux-x64.zip -d /tmp/nxd
cd /tmp/nxd/nexthmi-docker-linux-x64
./install.sh
# open http://localhost:8000, click around, edit a custom widget, verify
# hot-reload, toggle MCP on/off, then `docker compose down`
```

Optional — also publish to a registry for `docker pull` consumers:

```bash
docker tag nexthmi:0.x.y nexthmi:latest
# docker push <registry>/nexthmi:0.x.y && docker push <registry>/nexthmi:latest
```

## Binaries

PyInstaller cannot cross-compile, so each artifact is produced on a host
of the matching OS and arch.

### macOS (Apple Silicon)

```bash
# from repo root, with the 3.12 venv activated and pyinstaller installed
./build/build-binary.sh 0.x.y
```

Output: `dist/nexthmi-macos-arm64-<version>.zip`.

Smoke-test on a fresh macOS user account or a clean directory:

```bash
unzip dist/nexthmi-macos-arm64-*.zip -d /tmp/nx
xattr -dr com.apple.quarantine /tmp/nx/nexthmi-macos-arm64/
/tmp/nx/nexthmi-macos-arm64/nexthmi.command
```

Verify the banner shows the expected version, the UI loads at
http://127.0.0.1:8000, and editing a custom widget hot-reloads.

### Windows (x64)

In a PowerShell session on a Windows host, with the 3.12 venv activated
and `pyinstaller` installed:

```powershell
.\build\build-binary.ps1 -Version 0.x.y
```

Output: `dist\nexthmi-windows-x64-<version>.zip`.

Smoke-test on a clean unzip: confirm the SmartScreen workaround, the
banner, the UI in Edge, and a custom-widget edit cycle.

### macOS Intel (not in MVP)

Currently dropped. Rosetta doesn't make PyInstaller produce x64 output
from arm64 Python. Adding it back requires setting up an Intel macOS
build host and pointing the script at it; the script already handles
the `x86_64 → x64` arch tag, so no code changes are needed beyond a CI
runner.

## Sign-off

After verifying every artifact:

1. Push the release branch + tag.
2. Upload `nexthmi-macos-arm64-<version>.zip`,
   `nexthmi-windows-x64-<version>.zip`, and
   `nexthmi-docker-linux-<arch>.zip` to the release page (GitHub Releases
   or wherever the project lives).
3. Update [deploy.md](deploy.md)'s download URLs if they changed.
4. Optionally push the Docker image to a registry for `docker pull`
   consumers (the zip already carries the image for offline installs).
5. Publish the guide to the website, from a checkout that has `enterprise/`
   cloned in:

   ```bash
   NEXTHMI_EDITION=ee python build/publish-docs.py <promotion-website>/docs <version>
   ```

   This renders the release into `docs/v<version>/`, replaces `docs/` with
   the same version as "latest", and rewrites `docs/versions.json` and
   `docs/sitemap.xml`. Upload the whole `docs/` tree. Older releases stay
   where they are — the picker in the page header reads `versions.json` at
   load time, so a guide published a year ago starts offering the new version
   without being rebuilt.

   The edition is not optional here: the published guide carries the
   enterprise pages, and an `oss` render would delete two live URLs. The
   release workflow's `docs-site` job cannot produce that tree — `enterprise/`
   is not in the public repository — so its artifact is a build check, not the
   thing you upload. Publishing refuses to drop a page the site already
   serves; if that guard fires, the render is the wrong edition.

   The docs inside the release zips are **not** versioned this way. They are
   rendered by `render-docs.py` alone and show a fixed version label,
   because they describe exactly the executable they ship beside.

## Known frictions

- Code signing / notarization is out of scope. Operators see the
  unsigned-binary prompt on first launch. Document in `deploy.md`.
- No automated CI for binary builds — the matrix is a small enough that
  the maintainer's two laptops handle it. Revisit if release cadence
  picks up.
- `tree-sitter-languages` doesn't ship a current-Python wheel; we use
  `tree-sitter` + `tree-sitter-typescript` directly, both of which
  publish 3.14 wheels.

## Supported Python

One minor version is supported at a time: **>=3.14.2, <3.15**. Docker,
the portable builds, CI, and Ruff's `target-version` all track it
together.

Two 3.14 behaviour changes are load-bearing and covered by tests:

- `datetime.time.fromisoformat` accepts the ISO 8601 end-of-day hour 24,
  so OPC-UA write coercion bounds the hour itself rather than delegating
  to the parser (`services/write_service.py`).
- `socket.gethostbyaddr` is built on `getnameinfo` and waits out the
  resolver timeout (~35s) for an address with no PTR record, so the
  device-info reverse lookup runs off the event loop under a timeout
  (`api/device_api.py`).
