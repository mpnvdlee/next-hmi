#!/bin/bash
# NEXT HMI container entrypoint.
#
# Exec's the CMD passed in (the manager launcher). On first boot the manager
# seeds /data with a Default-Project from /app/project-seed/, writes
# projects.json, and starts that project through the supervisor.
#
# Started as root (the default), it first hands /data to the unprivileged
# `nexthmi` user and drops to it. Started with `docker run --user`, it runs the
# CMD as that user unchanged, so /data has to be writable by that user already.
#
# Using exec means signals (SIGTERM from `docker stop`) reach uvicorn
# directly and the lifespan shutdown runs — no orphaned OPC-UA pool
# processes.
set -euo pipefail

APP_USER=nexthmi

# The enterprise edition binds its license to the host's hardware UUID, which
# only root can read, so it keeps running as root.
if [ "$(id -u)" -ne 0 ] || [ "${NEXTHMI_EDITION:-oss}" = ee ]; then
  exec "$@"
fi

data="${NEXTHMI_DATA_DIR:-/data}"
mkdir -p "$data"
# A volume from before the app dropped root is root's. Only what the app user
# does not own yet changes hands, so the first start after the upgrade does the
# work and later starts change nothing. Symlinks and files with a second hard
# link are left alone: the app user can plant either, and chown would then hand
# it a file outside the volume, such as /etc/passwd.
find "$data" \( -type d -o -type f -links 1 \) ! -user "$APP_USER" \
  -exec chown "$APP_USER:" {} + \
  || echo "[entrypoint] some files under $data could not be given to $APP_USER" >&2

# setpriv keeps the environment, and HOME would still name root's home.
export HOME="/home/$APP_USER"
# --no-new-privs: no setuid binary in the image can take the process back to root.
exec setpriv --reuid="$APP_USER" --regid="$APP_USER" --init-groups --no-new-privs "$@"
