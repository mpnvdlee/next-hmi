import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ackAllAlarms } = vi.hoisted(() => ({ ackAllAlarms: vi.fn(async () => true) }));

vi.mock('@hmi/components/alarmUtils', () => ({ ackAllAlarms }));

import { executeWidgetActions } from './widgetActions';

beforeEach(() => {
  ackAllAlarms.mockClear();
});

describe('acknowledgeAllAlarms', () => {
  it('acknowledges every alarm, naming no user: the backend knows who is signed in', () => {
    executeWidgetActions([{ type: 'acknowledgeAllAlarms' }], { scope: 'runtime' });

    expect(ackAllAlarms).toHaveBeenCalledWith();
  });
});
