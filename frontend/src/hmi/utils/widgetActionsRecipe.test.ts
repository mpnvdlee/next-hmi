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

describe('recipeLoad / recipeSave dispatch', () => {
  it('recipeLoad sends recipe_load with datasetId + verify + requestId', () => {
    const action: ButtonAction = {
      type: 'recipeLoad',
      datasetId: { $static: 'espresso' },
      verify: true,
      onSuccess: [],
    };
    executeWidgetActions([action], { scope: 'runtime' });

    expect(beginAsyncAction).toHaveBeenCalledWith(action, 'runtime', undefined);
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: 'recipe_load',
      requestId: 'req-1',
      scope: 'runtime',
      datasetId: 'espresso',
      verify: true,
    });
  });

  it('recipeLoad skips dispatch when datasetId resolves empty', () => {
    executeWidgetActions([{ type: 'recipeLoad', datasetId: { $static: '' } }], {});
    expect(sendWsMessage).not.toHaveBeenCalled();
  });

  it('recipeSave sends recipe_save with datasetId when provided', () => {
    executeWidgetActions([{ type: 'recipeSave', datasetId: { $static: 'espresso' } }], {
      scope: 'runtime',
    });
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: 'recipe_save',
      requestId: 'req-1',
      scope: 'runtime',
      datasetId: 'espresso',
    });
  });

  it('recipeSave omits datasetId when not provided (targets loaded dataset)', () => {
    executeWidgetActions([{ type: 'recipeSave' }], { scope: 'runtime' });
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: 'recipe_save',
      requestId: 'req-1',
      scope: 'runtime',
    });
  });
});
