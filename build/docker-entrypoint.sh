#!/bin/bash
# NEXT HMI container entrypoint.
#
# Exec's the CMD passed in (the manager launcher). On first boot the manager
# seeds /data with a Default-Project from /app/project-seed/, writes
# projects.json, and starts that project through the supervisor.
#
# Using exec means signals (SIGTERM from `docker stop`) reach uvicorn
# directly and the lifespan shutdown runs — no orphaned OPC-UA pool
# processes.
set -euo pipefail
exec "$@"
