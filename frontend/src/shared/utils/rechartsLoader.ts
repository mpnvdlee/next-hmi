import { getMode } from './runtimeBase';

// Recharts is the one large third-party chart library the SDK exposes
// (window.__nextHMI__.Recharts, nextHmiSdk.ts). Manager-mode sessions never mount
// AppInner/HMI content (see App.tsx's mode branch) and never load custom
// widgets, so they never need it — deferring to a real dynamic import keyed
// off the runtime mode keeps it out of the manager's startup bundle. Instance
// sessions (HMI/editor) kick the fetch off immediately but asynchronously, so
// it never blocks first paint; widgetRegistry's loadCustomWidgets() awaits
// this before importing any compiled widget module, since those modules read
// window.__nextHMI__.Recharts synchronously at module-eval time. Awaiting this
// promise is therefore the whole contract: it resolves only once that slot is
// filled (see the assignment below).
//
// The `import('recharts')` call must stay inside a function body (called
// lazily, like every other `lazy(() => import(...))` in this codebase) rather
// than assigned directly to a top-level const: the bundler resolves a
// module-scope dynamic import that's evaluated unconditionally at load time
// into a static import, which would defeat the whole point here.
let _rechartsReady: Promise<typeof import('recharts') | null> | null = null;

export function ensureRecharts(): Promise<typeof import('recharts') | null> {
  if (!_rechartsReady) {
    _rechartsReady =
      getMode() === 'manager'
        ? Promise.resolve(null)
        : import('recharts').then((mod) => {
            // Filling the SDK slot here — on the shared promise, before it
            // resolves — is what makes `await ensureRecharts()` a guarantee
            // rather than a race. Publishing from a caller's `.then()` instead
            // only works while that caller happens to be queued first; a host
            // that never makes that call (a test harness, an embedder) would
            // leave the slot at its empty placeholder and every chart element
            // would resolve to `undefined`.
            if (typeof window !== 'undefined' && window.__nextHMI__) {
              window.__nextHMI__.Recharts = mod;
            }
            return mod;
          });
  }
  return _rechartsReady;
}
