import { describe, expect, it, vi } from 'vitest';
import type { ButtonAction } from '@shared/types/config';
import { pickPageGroup } from '@hmi/components/PageGroupStackContext';
import { executeWidgetActions } from './widgetActions';

const tab = (id: string) => ({ id, type: 'page' as const, title: id });
const tabs = [tab('scope'), tab('params'), tab('info')];

/** Fire `action` with the tab at `active` showing; returns where it navigated. */
function fire(action: ButtonAction, active: number, extra: Record<string, unknown> = {}) {
  const onNavigate = vi.fn();
  const stack = [
    {
      group: { id: 'device', type: 'page-group', children: tabs },
      activePage: tabs[active],
      onNavigate,
    },
  ] as never;
  executeWidgetActions([action], {
    evalCtx: { resolvePageGroup: (groupId) => pickPageGroup(stack, groupId), ...extra },
  });
  return onNavigate.mock.calls.map(([id]) => id);
}

describe('tab actions', () => {
  it('Next and Previous move one tab and stop at either end instead of wrapping', () => {
    expect(fire({ type: 'pageGroupNext' }, 0)).toEqual(['params']);
    expect(fire({ type: 'pageGroupNext' }, 2)).toEqual([]);
    expect(fire({ type: 'pageGroupPrevious' }, 2)).toEqual(['params']);
    expect(fire({ type: 'pageGroupPrevious' }, 0)).toEqual([]);
  });

  it('Page Group: Go To takes its index from any source and ignores one outside the tabs', () => {
    expect(fire({ type: 'pageGroupGoTo', index: 2 }, 0)).toEqual(['info']);
    const fromVar = { resolveVariable: () => 1 };
    expect(
      fire({ type: 'pageGroupGoTo', index: { $var: { path: 'PLC:nTab' } } }, 0, fromVar),
    ).toEqual(['params']);
    expect(fire({ type: 'pageGroupGoTo', index: 3 }, 0)).toEqual([]);
    expect(fire({ type: 'pageGroupGoTo', index: -1 }, 0)).toEqual([]);
    expect(fire({ type: 'pageGroupGoTo', index: { $var: { path: 'PLC:none' } } }, 1)).toEqual([]);
  });

  it('does nothing for a group that is not around the widget', () => {
    expect(fire({ type: 'pageGroupNext', groupId: '$parent' }, 0)).toEqual([]);
  });
});
