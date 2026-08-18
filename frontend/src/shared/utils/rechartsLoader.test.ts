import { describe, expect, it } from 'vitest';
import { installNextHmiSdk } from '../../nextHmiSdk';
import { ensureRecharts } from './rechartsLoader';

/**
 * The ordering guarantee `widgetRegistry` buys with its `await ensureRecharts()`:
 * a compiled widget module destructures `Recharts` off `window.__nextHMI__` at
 * module-eval time, so the slot must be filled by the time this promise
 * resolves — for every host, including one that only installs the SDK and never
 * calls `warmRecharts()`.
 */
describe('ensureRecharts', () => {
  it('fills the SDK slot before it resolves, with no warmRecharts() call', async () => {
    installNextHmiSdk();
    expect(window.__nextHMI__.Recharts.LineChart).toBeUndefined();

    await ensureRecharts();

    expect(window.__nextHMI__.Recharts.LineChart).toBeDefined();
  });
});
