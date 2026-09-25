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

### Project format

Before picking the tag, check whether `PROJECT_FORMAT_VERSION`
(`backend/core/project_migrations.py`) moved since the previous one:

```bash
git diff $(git describe --tags --abbrev=0)..HEAD -- backend/core/project_migrations.py | grep PROJECT_FORMAT_VERSION
```

If it did, two things follow — both before tagging:

- The tag must move the **minor or major**, never just the patch. The published
  contract is that a patch update never makes a project unopenable. Pre-release
  tags sit outside that rule — `x.y.z-rc*` sorts below `x.y.z`, so the release a
  candidate line leads up to may carry a format its own rc's did not.
- Set `PROJECT_FORMAT_MIN_APP` to this release's version. It is stamped into
  every project this build writes, and is the only way a future operator on an
  older build learns which version they need. Getting it wrong sends them to a
  version that cannot open their project.

This is the one release step that cannot be inferred from the code: at merge
time the release number does not exist yet.

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
# from repo root, with the 3.14 venv activated and pyinstaller installed
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

Then **save a page from the editor**. Page validation resolves every widget
type through the baked built-in-widgets manifest, which travels inside the SPA
bundle — so a bundle assembled without it produces a binary that renders fine and
rejects every save. `build/nexthmi.spec` refuses such a bundle outright, but
one save is the cheap end-to-end confirmation, and it is the one check a
checkout can never fail.

### Windows (x64)

In a PowerShell session on a Windows host, with the 3.14 venv activated
and `pyinstaller` installed:

```powershell
.\build\build-binary.ps1 -Version 0.x.y
```

Output: `dist\nexthmi-windows-x64-<version>.zip`.

Smoke-test on a clean unzip: confirm the SmartScreen workaround, the
banner, the UI in Edge, a custom-widget edit cycle, and a page save (same
reason as above).

### macOS Intel (not in MVP)

Currently dropped. Rosetta doesn't make PyInstaller produce x64 output
from arm64 Python. Adding it back requires setting up an Intel macOS
build host and pointing the script at it; the script already handles
the `x86_64 → x64` arch tag, so no code changes are needed beyond a CI
runner.

## Sign-off

After verifying every artifact:

1. Push the release branch, then the tag. A `v*` tag runs
   `.github/workflows/release-matrix.yml`, which rebuilds the whole matrix from
   a clean checkout: the frontend and backend suites, a Docker image plus
   first-boot/restart smoke test on each native arch, portable macOS arm64 and
   Windows x64 builds with the same smoke test, and a documentation-site render.
   The `release-readiness` job fails the release if any of those is red,
   skipped or missing, and both publish jobs hang off it.
2. Don't upload the portable zips by hand. On a green matrix `publish-release`
   attaches `nexthmi-macos-arm64-<version>.zip` and
   `nexthmi-windows-x64-<version>.zip` to the GitHub Release for the tag,
   creating it with generated notes when it does not exist yet; a tag carrying a
   hyphen (`v1.0.0-rc.1`) is published `--prerelease`, so only a bare `vX.Y.Z`
   can become "Latest". Check the Release page once the run is green. CI does
   not build the offline Docker installer — attach a locally built
   `nexthmi-docker-linux-<arch>.zip` yourself if the release needs one.
3. Update [deploy.md](deploy.md)'s download URLs if they changed.
4. The registry image is published for you, on a **final** tag only:
   `docker-publish` loads the two smoke-tested per-arch tarballs and pushes
   `ghcr.io/<repo>:<version>` and `:latest` as one multi-arch manifest. An RC
   tag builds and smoke-tests both images and publishes neither.
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

   Set `NEXTHMI_DOCS_ANALYTICS_TAG_FILE` to a file holding an HTML snippet and
   every published page carries it in its `<head>` — the latest copy and every
   archived version. The tag is not in this repository, and not because it is a
   secret: a hard-coded one would make every fork that publishes a guide report
   its readers to somebody else's analytics account. Whoever publishes the site
   supplies it; unset, the guide publishes without one.

   Only `--web` renders ever carry it. The docs inside a release zip, and the
   same tree served at `/help`, get nothing — gated on `offline` alongside the
   webfonts and the version picker, because a shop-floor panel has no internet
   and must never phone anywhere.

## Known frictions

- Code signing / notarization is out of scope. Operators see the
  unsigned-binary prompt on first launch. Document in `deploy.md`.
- The macOS leg of the matrix is Apple Silicon only, and no leg covers the
  quarantine/SmartScreen prompt a real browser download picks up, a
  double-clicked `nexthmi.command`, or graceful console-signal shutdown on
  Windows. Those still need a hand check on the built zips; the per-job
  comments in `release-matrix.yml` list what each leg leaves uncovered.
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
