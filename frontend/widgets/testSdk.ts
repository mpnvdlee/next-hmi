import { installNextHmiSdk, nextHmiSdk } from '../src/nextHmiSdk';
import { SDK_NAMES } from '../src/shared/utils/nextHmiSdkNames';

/**
 * Bind the runtime SDK for a stdlib widget unit test.
 *
 * A stdlib widget source imports nothing and references every helper as a free
 * identifier; the compiler resolves those by prepending a
 * `const { … } = window.__nextHMI__;` banner. A unit test imports the *source*,
 * so there is no banner — bind the same names on globalThis instead and the
 * identifiers resolve at call time exactly as they do in the browser.
 *
 * Deliberately NOT in src/test-setup.ts. Installing the SDK there pulls the app
 * module graph into every test file's registry before `vi.mock` factories run,
 * which silently defeats mocking in unrelated suites. Import it here, per stdlib
 * test file, and only those files pay for it:
 *
 *     import '../../testSdk';
 *
 * Loading a stdlib module by URL is handled separately, by the
 * `resolve.alias['@shared/utils/widgetModuleLoader']` entry in vitest.config.ts
 * — an app test that renders a stdlib widget needs that and not this.
 */
installNextHmiSdk();
for (const name of SDK_NAMES) {
  (globalThis as Record<string, unknown>)[name] = nextHmiSdk[name];
}

// `Recharts` is the one slot the SDK fills asynchronously — rechartsLoader
// writes the module into window.__nextHMI__ when the import resolves — so
// snapshotting it above would pin the empty placeholder forever. Bind it
// through instead; the setter keeps `globalThis.Recharts = …` working for a
// test that installs its own stub.
Object.defineProperty(globalThis, 'Recharts', {
  configurable: true,
  get: () => window.__nextHMI__.Recharts,
  set: (value: typeof nextHmiSdk.Recharts) => {
    window.__nextHMI__.Recharts = value;
  },
});
