#!/bin/bash
# Build a self-contained Docker distribution of NEXT HMI.
#
# Usage from repo root:
#   ./build/build-docker.sh [VERSION]
#   NEXTHMI_EDITION=ee ./build/build-docker.sh [VERSION]
#
# Produces (oss, the default):
#   dist/nexthmi-docker-linux-<arch>/        staged bundle
#   dist/nexthmi-docker-linux-<arch>-<version>.zip   the distributable
# and for ee, the same under nexthmi-enterprise-docker-linux-<arch>.
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

EDITION="${NEXTHMI_EDITION:-oss}"
case "$EDITION" in
  oss) ARTIFACT_BASE="nexthmi" ;;
  ee)  ARTIFACT_BASE="nexthmi-enterprise" ;;
  *) echo "Unknown NEXTHMI_EDITION '$EDITION' — expected 'oss' or 'ee'." >&2; exit 1 ;;
esac

DIST_DIR_NAME="${ARTIFACT_BASE}-docker-linux-${ARCH_TAG}"
OUTPUT_DIR="$REPO_ROOT/dist/$DIST_DIR_NAME"
IMAGE_TAG="$ARTIFACT_BASE:$VERSION"

echo "[build] NEXT HMI Docker $VERSION → $DIST_DIR_NAME"

# 1. Build the image. The Dockerfile internally handles SPA build,
#    esbuild vendoring, and seed widget bake — nothing to vendor here.
#    ee hands the Dockerfile the enterprise tree as a named context. Only its
#    backend/ and frontend/ are staged, so the rest of that checkout (its
#    node_modules, the website) never goes up with the build.
#    The stage lives outside the repo so the main context never carries it.
EE_ARGS=()
if [ "$EDITION" = "ee" ]; then
  if [ ! -f "$REPO_ROOT/enterprise/backend/manager_enterprise.py" ]; then
    echo "[build] NEXTHMI_EDITION=ee but enterprise/ is missing — clone the enterprise repository into enterprise/." >&2
    exit 1
  fi
  EE_STAGE="$(mktemp -d)"
  trap 'rm -rf "$EE_STAGE"' EXIT
  cp -R "$REPO_ROOT/enterprise/backend" "$REPO_ROOT/enterprise/frontend" "$EE_STAGE/"
  find "$EE_STAGE" -name __pycache__ -type d -prune -exec rm -rf {} +
  EE_ARGS=(--build-context "enterprise=$EE_STAGE")
fi
echo "[build] building image $IMAGE_TAG ($EDITION)"
docker build --build-arg NEXTHMI_VERSION="$VERSION" --build-arg NEXTHMI_EDITION="$EDITION" \
  "${EE_ARGS[@]+"${EE_ARGS[@]}"}" -t "$IMAGE_TAG" .

# 2. Stage the bundle dir
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# 3. Save image as a gzipped tarball
echo "[build] saving image → nexthmi-image.tar.gz"
docker save "$IMAGE_TAG" | gzip > "$OUTPUT_DIR/nexthmi-image.tar.gz"

# 4. Generated compose — uses the loaded tag, no build:, no registry
if [ "$EDITION" = "ee" ]; then
  # The license is bound to the machine, so the container takes the host's
  # identity: host networking shows it the host's wired network card, and the
  # host's machine-id is mounted read-only. The hardware UUID it reads itself,
  # as root. Recreating the container for an update then keeps the license.
  cat > "$OUTPUT_DIR/docker-compose.yml" <<YAML
services:
  nexthmi:
    image: $IMAGE_TAG
    container_name: nexthmi
    # Host networking: the app answers on the host's own 8000 (and 8443 with
    # HTTPS on), with no port mapping.
    network_mode: host
    volumes:
      - ./project-data:/data
      - /etc/machine-id:/etc/machine-id:ro
    restart: unless-stopped
YAML
else
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
fi

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
if [ "$EDITION" = "ee" ]; then
  PORTS_NOTE="The container uses the host's network, so the app answers on the host's own
port 8000, and on 8443 once HTTPS is on (Settings -> HTTPS).

License: the manager opens on the activation screen. Press Copy Device ID,
send it to licensing@next-hmi.com and paste the key you get back. Keep the
network_mode and /etc/machine-id lines in docker-compose.yml: they give the
container this host's identity, which is what the key is bound to. Linux
hosts only. Full guide:
https://next-hmi.com/docs/licensing.html#in-docker-or-a-virtual-machine"
else
  PORTS_NOTE="Turning on HTTPS (Settings -> HTTPS) moves the app to port 8443 and leaves
8000 redirecting there, so both ports are published. Keep them mapped
one-to-one — a remapped 8443 would be redirected to a port nothing serves."
fi
cat > "$OUTPUT_DIR/README.txt" <<README
NEXT HMI — Docker distribution $VERSION (linux/$ARCH_TAG, $EDITION)

Install:
  ./install.sh

Then open http://localhost:8000

The container bind-mounts ./project-data to /data. On first boot, a seed
workspace is copied into ./project-data/ so you have a working project
to explore. Subsequent restarts preserve whatever is in that folder.

$PORTS_NOTE

Stop:    docker compose down
Logs:    docker compose logs -f
Update:  replace the bundle with a newer version, run ./install.sh again
         (project-data is preserved).
README

# 7. Zip
ZIP_PATH="$REPO_ROOT/dist/${DIST_DIR_NAME}-${VERSION}.zip"
rm -f "$REPO_ROOT/dist/${DIST_DIR_NAME}"-*.zip "$REPO_ROOT/dist/${DIST_DIR_NAME}.zip"
(cd "$REPO_ROOT/dist" && zip -rqy "$ZIP_PATH" "$DIST_DIR_NAME")

# 8. Remove the staged folder — the zip is the deliverable.
rm -rf "$OUTPUT_DIR"

echo "[build] done: $ZIP_PATH"
