/**
 * Runtime base-path + app-mode awareness.
 *
 * The backend injects two globals into the served index.html (see
 * backend/services/frontend_serve.py):
 *
 *   window.__NEXTHMI_BASE__  — the URL prefix this document is served under:
 *                              "/" for the manager dashboard (and dev), or
 *                              "/runtime/<slug>/" / "/editor/<slug>/" for a
 *                              proxied project instance.
 *   window.__NEXTHMI_MODE__  — "manager" or "instance".
 *   window.__NEXTHMI_VERSION__ — the build's version string ("dev" in a checkout).
 *   window.__NEXTHMI_EDITION__ — "oss" or "ee".
 *
 * In dev (Vite) no globals are injected, so we default to base "/" + mode
 * "instance" — i.e. the single-project HMI, unchanged.
 *
 * Project instances are reverse-proxied by the manager under their prefix, so
 * every JS-driven URL the SPA emits (API calls, the WebSocket, router paths, and
 * project-content URLs like /assets and /widget-js) must carry that prefix.
 * Hashed bundle assets (/_app/…) stay absolute and are served at the origin root
 * by the manager, so they need no rewrite.
 */

declare global {
  interface Window {
    __NEXTHMI_BASE__?: string;
    __NEXTHMI_MODE__?: string;
    __NEXTHMI_VERSION__?: string;
    __NEXTHMI_EDITION__?: string;
  }
}

type AppMode = 'manager' | 'instance';

/** The URL prefix this document is served under, always with a trailing slash. */
export function getBasePath(): string {
  const raw = typeof window !== 'undefined' ? window.__NEXTHMI_BASE__ : undefined;
  if (!raw || raw === '/') return '/';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

export function getMode(): AppMode {
  const raw = typeof window !== 'undefined' ? window.__NEXTHMI_MODE__ : undefined;
  return raw === 'manager' ? 'manager' : 'instance';
}

/** The running build's version string. `"dev"` when no global was injected. */
export function getVersion(): string {
  const raw = typeof window !== 'undefined' ? window.__NEXTHMI_VERSION__ : undefined;
  return raw || 'dev';
}

/** The running build's edition. Defaults to `"oss"` when no global was injected. */
export function getEdition(): 'oss' | 'ee' {
  const raw = typeof window !== 'undefined' ? window.__NEXTHMI_EDITION__ : undefined;
  return raw === 'ee' ? 'ee' : 'oss';
}

/** Which project area this document serves, derived from the base prefix. */
type AppArea = 'runtime' | 'editor';

/**
 * The verb-prefixed base paths (`/runtime/<slug>/`, `/editor/<slug>/`) the
 * manager serves project content under. `getArea()` returns which one — so a
 * single SPA bundle renders the operator runtime or the editor from the URL.
 * Dev root `/` returns `null`; that keeps the older route-based behaviour in
 * `AppInner`.
 */
function areaMatch(): RegExpMatchArray | null {
  return getBasePath().match(/^\/(runtime|editor)\/([^/]+)\/$/);
}

export function getArea(): AppArea | null {
  const match = areaMatch();
  return match ? (match[1] as AppArea) : null;
}

/** The project slug carried in a `/runtime/<slug>/` or `/editor/<slug>/` base. */
export function projectSlug(): string | null {
  const match = areaMatch();
  return match ? match[2] : null;
}

/**
 * Router path for an editor sub-route. Under the `/editor/<slug>/` base the
 * router basename already carries the prefix, so sub-routes are root-relative
 * (`/datasources`); on the legacy `/config/*` mount they sit under `/config`.
 * `sub` starts with a slash (`/editor` → the page editor).
 */
export function editorPath(sub = ''): string {
  const prefix = getArea() === 'editor' ? '' : '/config';
  return `${prefix}${sub}` || '/';
}

/** React Router basename: "" at root, otherwise the current project-area prefix. */
export function routerBasename(): string {
  const base = getBasePath();
  return base === '/' ? '' : base.replace(/\/$/, '');
}

/**
 * Prefix a root-relative path with the runtime base. Idempotent — a path that
 * already carries the prefix (or isn't root-relative) is returned unchanged —
 * so it is safe to apply at both the URL builders and the consumption sites.
 */
export function withBase(path: string): string {
  const base = getBasePath();
  if (base === '/') return path;
  if (!path.startsWith('/')) return path;
  if (path === base.slice(0, -1) || path.startsWith(base)) return path;
  return base.slice(0, -1) + path;
}

/** Inverse of {@link withBase} — strip the base prefix to recover the logical path. */
export function stripBase(path: string): string {
  const base = getBasePath();
  if (base === '/') return path;
  const prefix = base.slice(0, -1);
  return path.startsWith(prefix) ? path.slice(prefix.length) || '/' : path;
}

/** Absolute ws(s):// URL for a backend WebSocket path, base-prefixed. */
export function wsUrl(path = '/ws'): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${withBase(path)}`;
}
