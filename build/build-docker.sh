#!/bin/bash
# Build a self-contained Docker distribution of NEXT HMI.
#
# Usage from repo root:
#   ./build/build-docker.sh [VERSION]
#
# Produces:
#   dist/nexthmi-docker-linux-<arch>/        staged bundle
#   dist/nexthmi-docker-linux-<arch>.zip     the distributable
#
# Bundle contents: a gzipped `docker save` tarball, a self-contained
# compose file, install.sh, version.txt, README.txt. End users unzip,
# run ./install.sh, and the app is up on http://localhost:8000.
#
# Prerequisites: Docker on PATH. Run on a Linux/macOS host whose
# architecture you want to produce (single-arch per host, like
# build-binary.sh).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="${1:-${NEXTHMI_VERSION:-dev}}"
ARCH_TAG="$(uname -m)"
case "$ARCH_TAG" in
  arm64|aarch64) ARCH_TAG="arm64" ;;
  x86_64|amd64)  ARCH_TAG="x64" ;;
esac

DIST_DIR_NAME="nexthmi-docker-linux-${ARCH_TAG}"
OUTPUT_DIR="$REPO_ROOT/dist/$DIST_DIR_NAME"
IMAGE_TAG="nexthmi:$VERSION"

echo "[build] NEXT HMI Docker $VERSION → $DIST_DIR_NAME"

# 1. Build the image. The Dockerfile internally handles SPA build,
#    esbuild vendoring, and seed widget bake — nothing to vendor here.
echo "[build] building image $IMAGE_TAG"
docker build -t "$IMAGE_TAG" .

# 2. Stage the bundle dir
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# 3. Save image as a gzipped tarball
echo "[build] saving image → nexthmi-image.tar.gz"
docker save "$IMAGE_TAG" | gzip > "$OUTPUT_DIR/nexthmi-image.tar.gz"

# 4. Generated compose — uses the loaded tag, no build:, no registry
cat > "$OUTPUT_DIR/docker-compose.yml" <<YAML
services:
  nexthmi:
    image: $IMAGE_TAG
    container_name: nexthmi
    ports:
      # With HTTPS enabled in Settings the app moves to 8443 and 8000 only
      # redirects there, so both have to be published for the toggle to work.
      - "8000:8000"
      - "8443:8443"
    volumes:
      - ./project-data:/data
    restart: unless-stopped
YAML

# 5. install.sh — single command for the end user
cat > "$OUTPUT_DIR/install.sh" <<'INSTALL'
#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
echo "[install] loading image…"
docker load -i nexthmi-image.tar.gz
echo "[install] starting…"
docker compose up -d
echo "[install] NEXT HMI is up. Open http://localhost:8000"
INSTALL
chmod +x "$OUTPUT_DIR/install.sh"

# 6. Version stamp + README
echo "$VERSION" > "$OUTPUT_DIR/version.txt"
cat > "$OUTPUT_DIR/README.txt" <<README
NEXT HMI — Docker distribution $VERSION (linux/$ARCH_TAG)

Install:
  ./install.sh

Then open http://localhost:8000

The container bind-mounts ./project-data to /data. On first boot, a seed
workspace is copied into ./project-data/ so you have a working project
to explore. Subsequent restarts preserve whatever is in that folder.

Turning on HTTPS (Settings -> HTTPS) moves the app to port 8443 and leaves
8000 redirecting there, so both ports are published. Keep them mapped
one-to-one — a remapped 8443 would be redirected to a port nothing serves.

Stop:    docker compose down
Logs:    docker compose logs -f
Update:  replace the bundle with a newer version, run ./install.sh again
         (project-data is preserved).
README

# 7. Zip
ZIP_PATH="$REPO_ROOT/dist/${DIST_DIR_NAME}.zip"
rm -f "$ZIP_PATH"
(cd "$REPO_ROOT/dist" && zip -rqy "$ZIP_PATH" "$DIST_DIR_NAME")

# 8. Remove the staged folder — the zip is the deliverable.
rm -rf "$OUTPUT_DIR"

echo "[build] done: $ZIP_PATH"
