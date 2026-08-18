#!/bin/bash
# Build a portable macOS (or Linux) binary distribution of NEXT HMI.
#
# Usage from repo root:
#   ./build/build-binary.sh [VERSION]
#   NEXTHMI_EDITION=ee ./build/build-binary.sh [VERSION]
#
# Produces (oss, the default):
#   dist/nexthmi/                            one-folder PyInstaller output
#   dist/nexthmi-<os>-<arch>-<version>.zip   the distributable
# and for ee, the same under nexthmi-enterprise/.
#
# Prerequisites: Python 3.14 with the project's deps + pyinstaller
# installed in the active venv, Node 20+ on PATH, esbuild installed
# globally via npm. PyInstaller can't cross-compile, so run on the host
# whose OS/arch you want to produce.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Scratch artifacts that mutate the source tree. We register an EXIT trap so
# an interrupt between steps 3 and 7 doesn't leave them lying around.
VENDOR_DIR="$REPO_ROOT/build/_vendor"
SEED_WIDGET_BUILD="$REPO_ROOT/build/_seed-widget-build"
cleanup_scratch() {
  rm -rf "$VENDOR_DIR" "$SEED_WIDGET_BUILD" "$REPO_ROOT/project-seed/.widget-build"
}
trap cleanup_scratch EXIT

VERSION="${1:-${NEXTHMI_VERSION:-dev}}"

# The edition selects the frontend alias target, the packaged backend tree, and
# the artifact name. It has to reach *both* the SPA build and PyInstaller: the
# spec bundles whatever is in frontend/dist/, so a frontend built for the other
# edition would be packaged as-is. Exported once here, used by both.
EDITION="${NEXTHMI_EDITION:-oss}"
case "$EDITION" in
  oss|ee) ;;
  *) echo "Unknown NEXTHMI_EDITION '$EDITION' — expected 'oss' or 'ee'." >&2; exit 1 ;;
esac
export NEXTHMI_EDITION="$EDITION"
if [ "$EDITION" = "ee" ] && [ ! -f "$REPO_ROOT/enterprise/frontend/registry.ts" ]; then
  echo "[build] NEXTHMI_EDITION=ee but enterprise/ is missing — clone the enterprise repository into enterprise/." >&2
  exit 1
fi

if [ "$EDITION" = "ee" ]; then
  ARTIFACT_BASE="nexthmi-enterprise"
else
  ARTIFACT_BASE="nexthmi"
fi

OS_NAME="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS_NAME" in
  darwin*) OS_TAG="macos" ;;
  linux*)  OS_TAG="linux" ;;
  *) echo "Unsupported OS: $OS_NAME" >&2; exit 1 ;;
esac
ARCH_TAG="$(uname -m)"
case "$ARCH_TAG" in
  arm64|aarch64) ARCH_TAG="arm64" ;;
  x86_64|amd64) ARCH_TAG="x64" ;;
esac

DIST_DIR_NAME="${ARTIFACT_BASE}-${OS_TAG}-${ARCH_TAG}"
PYI_OUT="$REPO_ROOT/dist/$ARTIFACT_BASE"

echo "[build] NEXT HMI $VERSION ($EDITION) → $DIST_DIR_NAME"

# 1. SPA bundle, built for this edition and stamped with it. The stamp is what
#    lets the spec refuse a bundle left behind by a build of the other edition;
#    it is removed first so an aborted build can never leave a stale stamp that
#    happens to match.
echo "[build] building frontend ($EDITION)"
rm -f "$REPO_ROOT/frontend/dist/.nexthmi-edition"
(cd frontend && npm ci)
if [ "$EDITION" = "ee" ]; then
  # enterprise/ carries no package.json, so Node can only resolve react and the
  # app's own aliases from that tree through a link to the frontend's modules.
  # Absolute target: enterprise/ is itself a symlink to a peer checkout (D6),
  # so a relative "../frontend/node_modules" would resolve against that peer
  # directory instead of this repo.
  ln -sfn "$REPO_ROOT/frontend/node_modules" "$REPO_ROOT/enterprise/node_modules"
fi
(cd frontend && npm run build)
echo "$EDITION" > "$REPO_ROOT/frontend/dist/.nexthmi-edition"

# 2. Vendor the esbuild binary + version stamp so the PyInstaller spec
#    can pick them up via build/_vendor/.
rm -rf "$VENDOR_DIR"
mkdir -p "$VENDOR_DIR"

ESBUILD_BIN="$(command -v esbuild || true)"
if [ -z "$ESBUILD_BIN" ]; then
  echo "[build] esbuild not found on PATH — install with 'npm install -g esbuild'" >&2
  exit 1
fi
cp "$ESBUILD_BIN" "$VENDOR_DIR/esbuild"
chmod +x "$VENDOR_DIR/esbuild"
echo "$VERSION" > "$VENDOR_DIR/version.txt"

# 3. Pre-compile bundled seed widgets so the very first launch on the end
#    user's machine doesn't have to esbuild against /project-seed/ before any HTML
#    can render. We use a throwaway widget-build dir under build/ to avoid
#    polluting the repo tree.
echo "[build] baking seed widget-build"
rm -rf "$SEED_WIDGET_BUILD"
NEXTHMI_ACTIVE_PROJECT_PATH="$REPO_ROOT/project-seed" \
NEXTHMI_WIDGET_BUILD_DIR="$SEED_WIDGET_BUILD" \
ESBUILD_BINARY_PATH="$VENDOR_DIR/esbuild" \
PYTHONPATH="$REPO_ROOT/backend" \
  python -m services.widget_compiler --once || \
  echo "[build] seed compile reported issues (continuing — failures are per-widget isolated)"
# Copy the baked artifacts inside project-seed/ so they ship with the binary; the
# launcher seeds /data from /project-seed on first run, then ensure_data_dirs()
# recreates .widget-build on demand.
if [ -d "$SEED_WIDGET_BUILD" ]; then
  rm -rf "$REPO_ROOT/project-seed/.widget-build"
  cp -a "$SEED_WIDGET_BUILD" "$REPO_ROOT/project-seed/.widget-build"
fi

# 4. Run PyInstaller
echo "[build] running PyInstaller"
rm -rf "$REPO_ROOT/build/build-pyinstaller" "$PYI_OUT"
pyinstaller \
  --noconfirm \
  --clean \
  --workpath "$REPO_ROOT/build/build-pyinstaller" \
  --distpath "$REPO_ROOT/dist" \
  "$REPO_ROOT/build/nexthmi.spec"

# 5. macOS launcher shortcut + version stamp
OUTPUT_DIR="$REPO_ROOT/dist/$DIST_DIR_NAME"
rm -rf "$OUTPUT_DIR"
mv "$PYI_OUT" "$OUTPUT_DIR"

if [ "$OS_TAG" = "macos" ]; then
  cat > "$OUTPUT_DIR/nexthmi.command" <<'CMD'
#!/bin/bash
cd "$(dirname "$0")" && ./nexthmi
CMD
  chmod +x "$OUTPUT_DIR/nexthmi.command"
fi

echo "$VERSION" > "$OUTPUT_DIR/version.txt"

# 6. Documentation. Rendered to self-contained HTML beside the executable, so
#    it is browsable straight from the unzipped folder and the manager can
#    serve it at /help for the editor's Help button (see api/docs_api.py).
echo "[build] rendering documentation"
python "$REPO_ROOT/build/render-docs.py" "$OUTPUT_DIR/docs" "$VERSION"

# 7. Zip. The name carries the version so two downloads of different releases
#    don't collide in a downloads folder; the folder *inside* stays
#    unversioned, because that's the path an operator's shortcuts point at.
ZIP_PATH="$REPO_ROOT/dist/${DIST_DIR_NAME}-${VERSION}.zip"
rm -f "$REPO_ROOT/dist/${DIST_DIR_NAME}"-*.zip "$REPO_ROOT/dist/${DIST_DIR_NAME}.zip"
(cd "$REPO_ROOT/dist" && zip -rqy "$ZIP_PATH" "$DIST_DIR_NAME")

# 8. Remove the staged folder — the zip is the deliverable.
rm -rf "$OUTPUT_DIR"

# 9. Cleanup vendor artifacts (handled by EXIT trap — see top of script).
echo "[build] done: $ZIP_PATH"
