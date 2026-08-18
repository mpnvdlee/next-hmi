# syntax=docker/dockerfile:1.7
# NEXT HMI single-image distribution.
#
# Four stages, because the SPA build has a Python step in the middle of it:
#
#   node-deps      node:20-slim — the npm tree plus the native esbuild binary.
#   stdlib-build   python-base + that esbuild — runs the backend's widget
#                  compiler over frontend/widgets/, producing the
#                  built-in widget modules the SPA serves from /stdlib-js/.
#   frontend-build node-deps + the compiled stdlib — the Vite/tsc build.
#   runtime        python-base — no Node — carrying only the built artifacts
#                  plus the FastAPI backend.
#
# The split exists because `npm run build` shells out to Python (see
# frontend/scripts/build-stdlib.mjs) and node:20-slim has no interpreter. The
# node stage runs `build:app`, which is `build` minus that shell-out, against
# the artifacts stage 2 already produced.

# ── Stage 1 — npm tree + esbuild binary ────────────────────────────────────
FROM node:20-slim AS node-deps
WORKDIR /src

COPY frontend/package*.json frontend/
RUN cd frontend && npm ci

# Vendor the esbuild binary used twice downstream: by stdlib-build to compile
# the built-in widgets, and by the runtime stage as the transformer for
# user-authored custom widgets. esbuild ships per-platform native binaries via
# npm; ``npm install -g esbuild`` drops the launcher at /usr/local/bin/esbuild
# on node:20-slim (npm's global bin == /usr/local/bin).
RUN npm install -g esbuild


# ── Shared Python base — interpreter + backend dependencies ────────────────
# Both the stdlib compile and the runtime need the same installed backend deps
# (the compiler imports tree_sitter), so they install once here.
FROM python:3.14-slim AS python-base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       libssl3 \
       ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt backend/
RUN pip install --no-cache-dir -r backend/requirements.txt


# ── Stage 2 — compile the stdlib widgets ───────────────────────────────────
FROM python-base AS stdlib-build
# Layout mirrors a checkout (/src/backend + /src/frontend) because the compiler
# resolves widgetRegistry.tsx relative to its own file, one level above backend/.
# NEXTHMI_DATA_DIR keeps runtime-home resolution inside the build container
# rather than falling through to ~/Documents/NextHMI.
ENV PYTHONPATH=/src/backend \
    ESBUILD_BINARY_PATH=/usr/local/bin/esbuild \
    NEXTHMI_DATA_DIR=/tmp/stdlib-runtime
WORKDIR /src

COPY --from=node-deps /usr/local/bin/esbuild /usr/local/bin/esbuild
COPY backend/ backend/
COPY frontend/ frontend/

# public/stdlib-js and .stdlib-build are gitignored but not dockerignored, so a
# developer's local compile can ride along in the build context. Drop it first —
# this compile is the only thing that may write those trees.
RUN rm -rf frontend/public/stdlib-js frontend/.stdlib-build \
  && python -m services.widget_compiler --once \
       --src-dir /src/frontend/widgets \
       --out-dir /src/frontend/.stdlib-build \
       --manifest /src/frontend/src/generated/stdlibManifest.json \
       --publish-dir /src/frontend/public/stdlib-js


# ── Stage 3 — build SPA bundle ─────────────────────────────────────────────
FROM node-deps AS frontend-build

COPY frontend/ frontend/
# Same stale-context reason as above; the COPYs below are the only source of
# the served stdlib modules and of the manifest the SPA imports statically.
# Both manifest halves have to come from this compile: the runtime half feeds
# widgetRegistry.tsx and the editor half feeds stdlibEditorMetadata.ts, so
# taking one from the compile and the other from a possibly stale build context
# ships a properties panel whose labels and defaults disagree with the schemas.
RUN rm -rf frontend/public/stdlib-js frontend/.stdlib-build
COPY --from=stdlib-build /src/frontend/public/stdlib-js frontend/public/stdlib-js
COPY --from=stdlib-build /src/frontend/src/generated/stdlibManifest.json frontend/src/generated/stdlibManifest.json
COPY --from=stdlib-build /src/frontend/src/generated/stdlibManifest.editor.json frontend/src/generated/stdlibManifest.editor.json

# `build:app` rather than `build`: this stage has no Python, and the stdlib
# compile that `build` would run first has already happened in stdlib-build.
RUN cd frontend && npm run build:app


# ── Stage 4 — runtime ───────────────────────────────────────────────────────
FROM python-base AS runtime
ENV PYTHONPATH=/app/backend

WORKDIR /app

COPY backend/ backend/
COPY --from=frontend-build /src/frontend/dist /app/frontend/dist
# Shared between backend (models/theme.py imports it at startup) and the
# frontend Theme Editor. Copied as a source file, not part of the SPA dist.
COPY --from=frontend-build /src/frontend/src/shared/themeDefaults.json /app/frontend/src/shared/themeDefaults.json
COPY --from=node-deps /usr/local/bin/esbuild /usr/local/bin/esbuild
# The backend's project_bootstrap looks here on first boot to seed
# /data/Default-Project/ when /data has no manifest yet.
COPY project-seed/ /app/project-seed/

ENV ESBUILD_BINARY_PATH=/usr/local/bin/esbuild \
    NEXTHMI_DATA_DIR=/data \
    NEXTHMI_FRONTEND_DIST=/app/frontend/dist \
    NEXTHMI_HOST=0.0.0.0 \
    NEXTHMI_WIDGET_BUILD_DIR=/data/.widget-build \
    WATCHFILES_FORCE_POLLING=1

VOLUME ["/data"]
# 8000 serves the app over HTTP; with HTTPS enabled it only redirects to 8443,
# which is where the app then binds.
EXPOSE 8000 8443

COPY build/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["python", "backend/launcher.py"]
