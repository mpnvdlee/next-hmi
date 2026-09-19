import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import { buildImportMap, resolveLiveProjectDir } from './dev-plugins/externalModules.ts';

/// <reference types="vitest/config" />

// Edition seam. `NEXTHMI_EDITION` (default "oss") picks which module the
// `@enterprise` alias resolves to — Metabase's MB_EDITION shape. The oss target
// is an empty stub committed here; the ee target lives in the enterprise
// repository, cloned into a gitignored `enterprise/` beside this checkout.
// Nothing is overwritten: the build selects one of the two.
function enterpriseRegistry(): string {
  const oss = path.resolve(import.meta.dirname, 'src/enterprise/registry.ts');
  if ((process.env.NEXTHMI_EDITION ?? 'oss') !== 'ee') return oss;
  const ee = path.resolve(import.meta.dirname, '../enterprise/frontend/registry.ts');
  if (!fs.existsSync(ee)) {
    throw new Error(
      `NEXTHMI_EDITION=ee but ${ee} is missing — clone the enterprise repository into enterprise/.`,
    );
  }
  return ee;
}

// Custom-widget TSX compilation + widget-schemas.json regeneration is owned by
// the backend (services/widget_compiler.py) in both dev and prod, so the
// deployed runtime (Docker / PyInstaller) — which ships no Node — has the
// same hot-reload story as a dev checkout. The browser receives the
// `widget_updated` message over the app /ws (see widgetUpdatedBus.ts).

// ── External-module import-map plugin ─────────────────────────────────────────
// Scans the live project's external-libraries/ and builds a browser import
// map so widgets can `import * as THREE from 'three'` after dropping the
// library into external-libraries/.
// Pure helpers (scanExternalLibraries, readOverrides, buildImportMap) and the
// live-project resolver live in ./dev-plugins/externalModules.ts so they can
// be unit-tested.

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
// Resolved from the runtime-home manifest, not assumed to be
// `<repo>/project-testbench/` — see resolveLiveProjectDir.
const LIVE_PROJECT_DIR = resolveLiveProjectDir(REPO_ROOT);
const EXTERNAL_LIBRARIES_DIR = path.join(LIVE_PROJECT_DIR, 'external-libraries');
const OVERRIDE_PATH = path.join(LIVE_PROJECT_DIR, 'external-modules.json');

// The manager serves project content under two verb-first prefixes:
// /runtime/<slug>/ and /editor/<slug>/. Project-content URLs (/assets,
// /widget-js, /external-libraries, …) are only proxied to the backend when
// they carry that prefix, so anything injected into an instance document must
// be base-prefixed too.
function instanceBaseFromUrl(url: string): string {
  const match = url.match(/^\/(runtime|editor)\/([^/]+)\//);
  return match ? `/${match[1]}/${match[2]}/` : '/';
}

function externalModulesPlugin(): Plugin {
  let importMap: { imports: Record<string, string> } = { imports: {} };
  let serialized = '{"imports":{}}';

  const refresh = (reason: string): boolean => {
    importMap = buildImportMap(EXTERNAL_LIBRARIES_DIR, OVERRIDE_PATH);
    const next = JSON.stringify(importMap);
    if (next === serialized) return false;
    serialized = next;
    const count = Object.keys(importMap.imports).length;
    console.log(`[NEXTHMI] external modules: ${count} import-map entries (${reason})`);
    return true;
  };

  return {
    name: 'nextHMI-external-modules',
    buildStart() {
      // Say which project the map came from: an empty map is otherwise
      // indistinguishable from a project that has no libraries, and the
      // failure only surfaces later as an unresolved bare specifier.
      console.log(`[NEXTHMI] live project: ${LIVE_PROJECT_DIR}`);
      if (!fs.existsSync(EXTERNAL_LIBRARIES_DIR)) {
        console.log(`[NEXTHMI] no external-libraries/ there — import map is empty`);
      }
      refresh('startup');
    },
    configureServer(server) {
      // Watching a missing path makes chokidar noisy on some platforms, same
      // as OVERRIDE_PATH below; creating it mid-session needs a restart.
      if (fs.existsSync(EXTERNAL_LIBRARIES_DIR)) server.watcher.add(EXTERNAL_LIBRARIES_DIR);
      // Only watch OVERRIDE_PATH when it already exists — chokidar logs a
      // spurious error on some platforms when handed a missing path. Creating
      // the override file mid-session requires a server restart.
      if (fs.existsSync(OVERRIDE_PATH)) server.watcher.add(OVERRIDE_PATH);

      const onExternalLibrariesChange = (filePath: string) => {
        const normalized = path.resolve(filePath);
        const inExternalLibraries =
          normalized === EXTERNAL_LIBRARIES_DIR ||
          normalized.startsWith(EXTERNAL_LIBRARIES_DIR + path.sep);
        const isOverride = normalized === OVERRIDE_PATH;
        if (!inExternalLibraries && !isOverride) return;
        // Skip the full-reload when the scan-relevant surface didn't change —
        // editing a deep file under an external-libraries subfolder doesn't
        // alter the top-level import map.
        if (!refresh(`change: ${path.relative(LIVE_PROJECT_DIR, normalized)}`)) return;
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('add', onExternalLibrariesChange);
      server.watcher.on('change', onExternalLibrariesChange);
      server.watcher.on('unlink', onExternalLibrariesChange);
      server.watcher.on('addDir', onExternalLibrariesChange);
      server.watcher.on('unlinkDir', onExternalLibrariesChange);
    },
    transformIndexHtml: {
      order: 'pre',
      handler(_html, ctx) {
        if (Object.keys(importMap.imports).length === 0) return;
        // Import-map values are root-absolute (/external-libraries/…). Under an
        // instance document (/editor/<slug>/) those URLs are only proxied to the
        // backend when prefixed with the instance base, so rewrite them here.
        const base = instanceBaseFromUrl(ctx.originalUrl || '/');
        const prefixed =
          base === '/'
            ? importMap
            : {
                imports: Object.fromEntries(
                  Object.entries(importMap.imports).map(([key, value]) => [
                    key,
                    value.startsWith('/') ? base + value.slice(1) : value,
                  ]),
                ),
              };
        return [
          {
            tag: 'script',
            attrs: { type: 'importmap' },
            children: JSON.stringify(prefixed),
            injectTo: 'head-prepend',
          },
        ];
      },
    },
  };
}

// ── Runtime globals (dev) ─────────────────────────────────────────────────────
// In production the backend injects window.__NEXTHMI_BASE__ / __NEXTHMI_MODE__
// into index.html (see backend/services/frontend_serve.py). In dev Vite serves
// index.html, so we inject them here based on the request path: the manager
// dashboard at the origin root, a project instance under /runtime/<slug>/ or
// /editor/<slug>/. This lets the same SPA render the manager at
// http://localhost:8000/ and a proxied project at
// http://localhost:8000/runtime/<slug>/ with HMR intact.
// Serve-only: at build time there is no request to derive base/mode from, so a
// baked tag can only ever say base "/" + mode "manager". It also lands *after*
// the one the backend injects at <head>, so it would win and render every
// proxied project instance as the manager dashboard (issue #20). The backend
// strips stray tags defensively; not emitting one is the other half.
function runtimeGlobalsPlugin(): Plugin {
  return {
    name: 'nextHMI-runtime-globals',
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      handler(_html, ctx) {
        const url = ctx.originalUrl || '/';
        // The manager serves project content under two verb-first prefixes:
        // /runtime/<slug>/ and /editor/<slug>/. Either is an instance document;
        // everything else is the manager SPA.
        const base = instanceBaseFromUrl(url);
        const mode = base === '/' ? 'manager' : 'instance';
        return [
          {
            tag: 'script',
            children: `window.__NEXTHMI_BASE__=${JSON.stringify(base)};window.__NEXTHMI_MODE__=${JSON.stringify(mode)};window.__NEXTHMI_VERSION__="dev";window.__NEXTHMI_EDITION__=${JSON.stringify(process.env.NEXTHMI_EDITION === 'ee' ? 'ee' : 'oss')};`,
            injectTo: 'head-prepend',
          },
        ];
      },
    },
  };
}

// ── Dev TLS ───────────────────────────────────────────────────────────────────
// start-dev.py resolves the runtime home's certificate pair (the one Settings →
// HTTPS manages, same call the launcher makes) and passes the paths in, so the
// resolution order stays in one place instead of being re-derived here. Without
// it Vite serves plain HTTP and https://localhost:8000 fails the handshake even
// though the device is configured for HTTPS.
const devTlsCert = process.env.NEXTHMI_DEV_TLS_CERT;
const devTlsKey = process.env.NEXTHMI_DEV_TLS_KEY;
const devTls =
  devTlsCert && devTlsKey && fs.existsSync(devTlsCert) && fs.existsSync(devTlsKey)
    ? {
        cert: fs.readFileSync(devTlsCert),
        key: fs.readFileSync(devTlsKey),
        passphrase: process.env.NEXTHMI_SSL_KEYFILE_PASSWORD || undefined,
      }
    : undefined;

// ── Dev bind address ──────────────────────────────────────────────────────────
// Same resolution as backend/core/net.py: every interface unless NEXTHMI_HOST
// names one, so the dev server is reachable the way a real install is.
// `true`, not '0.0.0.0': Vite maps `true` to an undefined host, which makes
// node listen on `::` dual-stack, while '0.0.0.0' is the IPv4 wildcard and
// binds that family alone. Browsers resolve `localhost` to `::1` first, so the
// literal spelling refuses http://localhost:8000 while 127.0.0.1 still answers.
const nexthmiHost = process.env.NEXTHMI_HOST?.trim();
const devHost = nexthmiHost || true;

// Vite answers "Blocked request. This host is not allowed." to any Host header
// that is neither an IP literal nor a listed name — its DNS-rebinding guard.
// A machine with several adapters is reached under more names than it can
// enumerate: a DNS name per subnet, the mDNS `.local`, whatever a bench tablet
// carries in its own hosts file. Listing them is a losing game, and the one
// left out reads as "the dev server is down" from that adapter. `true` accepts
// any name that resolves here, which is what binding every interface already
// promised. What it gives up is the guard against a page elsewhere pointing a
// name it controls at this machine and reading `/@fs` — whose root is a
// checkout's `frontend/`; `NEXTHMI_HOST=127.0.0.1` pins both servers back to
// loopback where the network is not one to be on at all.
const devAllowedHosts = true;

// ── Dev ports ─────────────────────────────────────────────────────────────────
// The app answers on :8000 here exactly as it does in a release install, where
// the manager serves the built SPA and its API from one origin — so a bookmark,
// a screenshot or a bug report carries between a checkout and an install. The
// API server sits next door on :8001 and the proxy below stitches the two back
// into that one origin. start-dev.py passes both from its own constants; these
// defaults are for a bare `npm run dev`, and the two must never disagree —
// a proxy aimed at Vite's own port is a request loop, not an error.
const devPort = Number(process.env.NEXTHMI_DEV_PORT) || 8000;
const devApiPort = Number(process.env.NEXTHMI_DEV_API_PORT) || 8001;

// Same pin as devHost, not a fresh localhost default: start-dev.py passes
// NEXTHMI_HOST through untouched to uvicorn's --reload bind, so pinning it to
// a LAN address makes the backend answer ONLY there (see start-dev.py's
// _reload_bind_host) — localhost stops being reachable at all, and every
// proxied /api, /plugins, /help, /mcp and /ws hop would be refused. Bracketed
// because an IPv6 literal in a URL needs it; falling back to `localhost` when
// unset mirrors what "every interface" already includes: loopback.
const backendHost = nexthmiHost
  ? nexthmiHost.includes(':')
    ? `[${nexthmiHost}]`
    : nexthmiHost
  : 'localhost';
const backendOrigin = `${devTls ? 'https' : 'http'}://${backendHost}:${devApiPort}`;
const backendWsOrigin = `${devTls ? 'wss' : 'ws'}://${backendHost}:${devApiPort}`;
// The pair is self-signed by default, so the proxy must not verify it.
const backendProxy = { target: backendOrigin, secure: false };

// Shared cleanup for ws-upgrade proxies — silences expected disconnect noise.
// Extracted so the app WebSocket (/ws and the proxied /runtime/<slug>/ws) share it.
// Typed from Vite's own ProxyOptions so we don't depend on http-proxy types.
type ProxyConfigure = NonNullable<import('vite').ProxyOptions['configure']>;
const wsProxyCleanup: ProxyConfigure = (proxy) => {
  proxy.removeAllListeners('error');
  proxy.on('error', () => {});
  proxy.on('proxyReqWs', (proxyReq, _req, socket) => {
    const browserSocket = socket as unknown as import('net').Socket;
    let backendSocket: import('net').Socket | null = null;
    const captureBackend = () => {
      const s = (proxyReq as import('http').ClientRequest).socket as import('net').Socket | null;
      if (s && s !== backendSocket) {
        backendSocket = s;
        backendSocket.on('error', () => {});
      }
    };
    setImmediate(() => {
      browserSocket.removeAllListeners('error');
      browserSocket.on('error', () => {});
    });
    browserSocket.on('end', () => {
      captureBackend();
      (proxyReq as import('http').ClientRequest).removeAllListeners('error');
      (proxyReq as import('http').ClientRequest).on('error', () => {});
      if (!browserSocket.destroyed) browserSocket.destroy();
      if (backendSocket && !backendSocket.destroyed) backendSocket.destroy();
    });
    proxyReq.on('socket', () => captureBackend());
    proxyReq.on('upgrade', () => captureBackend());
  });
};

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [externalModulesPlugin(), runtimeGlobalsPlugin(), react()],
  build: {
    // SPA bundle assets ship under /_app/* so they don't collide with the
    // backend's /assets mount (the live project's icons/images). Backend serves
    // /_app/* directly from dist/_app/ when NEXTHMI_FRONTEND_DIST is set.
    assetsDir: '_app',
    // Consumed by scripts/check-bundle-budget.mjs (backlog item 22) to walk
    // each entry/route's real static-import closure and enforce size budgets.
    manifest: true,
    // vendor-charts sits just over the 500 kB default and is loaded on demand
    // (ensureRecharts), so the stock warning fires on every build for a chunk
    // no first paint waits on. Raised just past it rather than disabled: real
    // per-route regressions are caught by the budget script above, and further
    // growth in this chunk still warns.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Rolldown's legacy `manualChunks(id)` shim doesn't reliably isolate a
        // narrowly-scoped group (e.g. react) from a broader one (e.g. charts)
        // when the broad group's own dependency traversal reaches the narrow
        // group's modules first — react/react-dom's CJS interop wrapper ended
        // up physically inlined into the recharts vendor chunk despite this id
        // check correctly naming it 'vendor-react'. `codeSplitting.groups` is
        // rolldown's native replacement and supports an explicit `priority` so
        // higher-priority groups always claim their modules first regardless
        // of which chunk's dependency graph reaches them first (see backlog
        // item 22 for the trace that found this).
        codeSplitting: {
          groups: [
            {
              name: 'vendor-react',
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 100,
            },
            { name: 'vendor-router', test: /[\\/]node_modules[\\/]react-router/, priority: 90 },
            { name: 'vendor-dnd', test: /[\\/]node_modules[\\/]@dnd-kit[\\/]/, priority: 90 },
            {
              name: 'vendor-virtual',
              test: /[\\/]node_modules[\\/]@tanstack[\\/]react-virtual[\\/]/,
              priority: 90,
            },
            { name: 'vendor-state', test: /[\\/]node_modules[\\/]zustand[\\/]/, priority: 90 },
            {
              name: 'vendor-icons',
              test: /[\\/]node_modules[\\/]@phosphor-icons[\\/]/,
              priority: 90,
            },
            {
              name: 'vendor-charts',
              test: /[\\/]node_modules[\\/](recharts|d3-[^\\/]+)[\\/]/,
              priority: 50,
            },
            { name: 'vendor-misc', test: /[\\/]node_modules[\\/]/, priority: 0 },
          ],
        },
      },
    },
  },
  resolve: {
    alias: {
      '@hmi': path.resolve(import.meta.dirname, 'src/hmi'),
      '@config': path.resolve(import.meta.dirname, 'src/config'),
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
      '@enterprise': enterpriseRegistry(),
    },
  },
  server: {
    host: devHost,
    port: devPort,
    // Landing on the next free port instead would put the app somewhere the
    // banner does not name and, worse, somewhere `--stop` does not clear.
    strictPort: true,
    allowedHosts: devAllowedHosts,
    // Vite's forwardConsole pipes every browser console.* into the dev terminal,
    // which buries our own [NEXTHMI] compile/restart logs in noise from user widgets.
    forwardConsole: false,
    https: devTls,
    proxy: {
      // Manager-level APIs (auth, supervisor, projects, admin) live on the
      // manager backend next door — see devApiPort.
      '/api': backendProxy,
      '/plugins': backendProxy,
      // Documentation behind the Help button — bundled docs in a packaged
      // build, a redirect to the public page from a checkout.
      '/help': backendProxy,
      // The workspace MCP endpoint (docs/dev/reference/mcp.md) — the manager's
      // stable origin for AI-agent tooling. Without this a GET falls into the
      // SPA catch-all (200, the app shell) and a POST 404s, both silently: an
      // MCP client would need to know to point at :8001 instead of the app
      // port everything else uses.
      '/mcp': backendProxy,
      // /docs, /openapi.json and /redoc (FastAPI's own interactive schema) are
      // shadowed the same way but are deliberately left unproxied: manager.py's
      // _is_gated() never covers them at the manager's top level, so they are
      // already unauthenticated and already reachable directly at the API port
      // (:8001) in dev. Proxying them here would only move that existing gap
      // onto the primary dev URL for no functional gain — closing the gap
      // itself is a manager auth-gate change, not a dev-proxy one.
      // A project instance's backend content is reached through the manager's
      // reverse proxy under its prefix; the SPA routes (/runtime/<slug>/ and
      // /runtime/<slug>/pages/…) are NOT matched here, so Vite serves them with HMR.
      '^/(runtime|editor)/[^/]+/(api|assets|widgets|widget-js|builtin-widgets-js|external-libraries|plugins)(/|$)':
        backendProxy,
      '^/(runtime|editor)/[^/]+/ws$': {
        target: backendWsOrigin,
        ws: true,
        secure: false,
        configure: wsProxyCleanup,
      },
      '/ws': {
        target: backendWsOrigin,
        ws: true,
        secure: false,
        configure: wsProxyCleanup,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
    globals: true,
  },
});
