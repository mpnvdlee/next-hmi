import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ackAllAlarms } = vi.hoisted(() => ({ ackAllAlarms: vi.fn(async () => true) }));

vi.mock('@hmi/components/alarmUtils', () => ({ ackAllAlarms }));

import { useHmiStore } from '@hmi/store/hmiStore';
import { executeWidgetActions } from './widgetActions';

beforeEach(() => {
  ackAllAlarms.mockClear();
  useHmiStore.setState({ currentUsersByScope: {} });
});

describe('acknowledgeAllAlarms', () => {
  it('acknowledges every alarm as the user signed in on that scope', () => {
    useHmiStore.setState({
      currentUsersByScope: {
        runtime: { username: 'matilda', groups: ['operator'], groupLabels: {} },
      },
    });
    executeWidgetActions([{ type: 'acknowledgeAllAlarms' }], { scope: 'runtime' });

    expect(ackAllAlarms).toHaveBeenCalledWith('matilda');
  });

  it('falls back to the operator name when nobody is signed in', () => {
    executeWidgetActions([{ type: 'acknowledgeAllAlarms' }], { scope: 'runtime' });

    expect(ackAllAlarms).toHaveBeenCalledWith('operator');
  });
});
