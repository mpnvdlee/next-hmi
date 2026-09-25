import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ButtonAction } from '@shared/types/config';

const { sendWsMessage, beginAsyncAction } = vi.hoisted(() => ({
  sendWsMessage: vi.fn(),
  beginAsyncAction: vi.fn(() => 'req-1'),
}));

vi.mock('@hmi/hooks/useWebSocket', () => ({ sendWsMessage }));
vi.mock('@hmi/utils/actionDispatcher', () => ({ beginAsyncAction }));

import { executeWidgetActions } from './widgetActions';

beforeEach(() => {
  sendWsMessage.mockClear();
  beginAsyncAction.mockClear();
});

describe('toggleDataVariable dispatch', () => {
  it('sends toggle_field with no value — the server reads the current one', () => {
    const action: ButtonAction = {
      type: 'toggleDataVariable',
      datasource: 'PLC',
      path: 'Motor1/Run',
      onFailed: [],
    };
    executeWidgetActions([action], { scope: 'runtime' });

    expect(beginAsyncAction).toHaveBeenCalledWith(action, 'runtime', undefined);
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: 'toggle_field',
      requestId: 'req-1',
      scope: 'runtime',
      datasource: 'PLC',
      path: 'Motor1/Run',
    });
  });

  it('skips dispatch when no variable is bound', () => {
    executeWidgetActions([{ type: 'toggleDataVariable', datasource: '', path: '' }], {});
    expect(sendWsMessage).not.toHaveBeenCalled();
    expect(beginAsyncAction).not.toHaveBeenCalled();
  });
});
