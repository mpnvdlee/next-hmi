import { afterEach, describe, expect, it, vi } from 'vitest';

const { ackAllAlarms } = vi.hoisted(() => ({ ackAllAlarms: vi.fn(async () => true) }));

vi.mock('@hmi/components/alarmUtils', () => ({ ackAllAlarms }));

import { executeWidgetActions } from './widgetActions';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reloadHmi', () => {
  it('reloads the page and runs nothing after it', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });

    executeWidgetActions([{ type: 'reloadHmi' }, { type: 'acknowledgeAllAlarms' }]);

    expect(reload).toHaveBeenCalledOnce();
    expect(ackAllAlarms).not.toHaveBeenCalled();
  });
});
