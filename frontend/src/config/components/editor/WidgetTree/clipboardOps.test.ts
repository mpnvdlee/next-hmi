import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHmiStore } from '@hmi/store/hmiStore';
import type { WidgetConfig, PageConfig, PageGroupConfig, DialogConfig } from '@shared/types/config';
import { copyTreeNode, pasteToast, readTreeNodeFromClipboard, regenerateIds } from './clipboardOps';

function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  const readText = vi.fn().mockResolvedValue('');
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText, readText },
    configurable: true,
  });
  return { writeText, readText };
}

beforeEach(() => {
  useHmiStore.setState({ pendingToasts: [] });
});

describe('copyTreeNode', () => {
  it('writes the JSON-serialized node and shows an info toast', async () => {
    const { writeText } = stubClipboard();
    const widget: WidgetConfig = { id: 'w1', type: 'Button', name: 'Button 1' };

    await copyTreeNode({ kind: 'widget', node: widget });

    expect(writeText).toHaveBeenCalledWith(JSON.stringify(widget));
    expect(useHmiStore.getState().pendingToasts).toHaveLength(1);
    expect(useHmiStore.getState().pendingToasts[0]).toMatchObject({
      severity: 'info',
      message: 'Copied component',
    });
  });

  it('shows an error toast when the clipboard write is blocked', async () => {
    const { writeText } = stubClipboard();
    writeText.mockRejectedValueOnce(new Error('denied'));

    await copyTreeNode({ kind: 'dialog', node: { id: 'd1', title: 'D', widgets: [] } });

    expect(useHmiStore.getState().pendingToasts[0]).toMatchObject({
      severity: 'error',
      message: 'Clipboard write blocked',
    });
  });
});

describe('readTreeNodeFromClipboard', () => {
  it('shows an error toast and returns null when the clipboard read is blocked', async () => {
    const { readText } = stubClipboard();
    readText.mockRejectedValueOnce(new Error('denied'));

    const result = await readTreeNodeFromClipboard();

    expect(result).toBeNull();
    expect(useHmiStore.getState().pendingToasts[0]).toMatchObject({
      severity: 'error',
      message: 'Clipboard read blocked',
    });
  });

  it('shows an error toast and returns null for non-JSON clipboard content', async () => {
    const { readText } = stubClipboard();
    readText.mockResolvedValueOnce('not json{{');

    const result = await readTreeNodeFromClipboard();

    expect(result).toBeNull();
    expect(useHmiStore.getState().pendingToasts[0]).toMatchObject({
      message: 'Clipboard is not valid JSON',
    });
  });

  it('shows an error toast and returns null for JSON that is not a copyable node', async () => {
    const { readText } = stubClipboard();
    readText.mockResolvedValueOnce(JSON.stringify({ foo: 'bar' }));

    const result = await readTreeNodeFromClipboard();

    expect(result).toBeNull();
    expect(useHmiStore.getState().pendingToasts[0]).toMatchObject({
      message: 'Clipboard is not a copyable tree node',
    });
  });

  it('classifies a widget node', async () => {
    const { readText } = stubClipboard();
    const widget: WidgetConfig = { id: 'w1', type: 'Button', name: 'Button 1' };
    readText.mockResolvedValueOnce(JSON.stringify(widget));

    const result = await readTreeNodeFromClipboard();

    expect(result).toEqual({ kind: 'widget', node: widget });
  });

  it('classifies a page node by its sections field', async () => {
    const { readText } = stubClipboard();
    const page = { id: 'p1', title: 'Page', sections: { content: [] } };
    readText.mockResolvedValueOnce(JSON.stringify(page));

    const result = await readTreeNodeFromClipboard();

    expect(result?.kind).toBe('page');
  });

  it('classifies a page-group node by its type and children array', async () => {
    const { readText } = stubClipboard();
    const group = { id: 'g1', title: 'Group', type: 'page-group', children: [] };
    readText.mockResolvedValueOnce(JSON.stringify(group));

    const result = await readTreeNodeFromClipboard();

    expect(result?.kind).toBe('page-group');
  });

  it('classifies a dialog node by its title + widgets shape', async () => {
    const { readText } = stubClipboard();
    const dialog = { id: 'd1', title: 'Dialog', widgets: [] };
    readText.mockResolvedValueOnce(JSON.stringify(dialog));

    const result = await readTreeNodeFromClipboard();

    expect(result?.kind).toBe('dialog');
  });
});

describe('regenerateIds', () => {
  it('assigns a fresh id to a widget and recurses into its children', () => {
    const widget: WidgetConfig = {
      id: 'motor-1',
      type: 'Container',
      name: 'Motor',
      children: [{ id: 'motor-1-child', type: 'Button', name: 'Motor' }],
    };
    const taken = new Set(['motor-1']);

    const result = regenerateIds({ kind: 'widget', node: widget }, taken) as {
      kind: 'widget';
      node: WidgetConfig;
    };

    expect(result.node.id).not.toBe('motor-1');
    expect(result.node.children?.[0].id).not.toBe('motor-1-child');
    expect(result.node.children?.[0].id).not.toBe(result.node.id);
    // Original input is untouched.
    expect(widget.id).toBe('motor-1');
  });

  it('assigns a fresh id to a page, its sections widgets, and defaults an empty content section', () => {
    const page: PageConfig = {
      id: 'page-1',
      title: 'Overview',
      type: 'page',
      sections: { main: [{ id: 'w1', type: 'Button', name: 'Overview' }] },
    };
    const taken = new Set(['page-1']);

    const result = regenerateIds({ kind: 'page', node: page }, taken) as {
      kind: 'page';
      node: PageConfig;
    };

    expect(result.node.id).not.toBe('page-1');
    expect(result.node.sections.main[0].id).not.toBe('w1');
    expect(Object.keys(result.node.sections)).toContain('main');
  });

  it('defaults a page with no sections to an empty content section', () => {
    const page = { id: 'page-1', title: 'Overview', type: 'page', sections: {} } as PageConfig;
    const result = regenerateIds({ kind: 'page', node: page }, new Set()) as {
      kind: 'page';
      node: PageConfig;
    };
    expect(result.node.sections).toEqual({ content: [] });
  });

  it('assigns fresh ids through a nested page-group tree, including header/footer widgets', () => {
    const group: PageGroupConfig = {
      id: 'group-1',
      title: 'Area',
      type: 'page-group',
      header: [{ id: 'h1', type: 'Button', name: 'Header Btn' }],
      footer: [{ id: 'f1', type: 'Button', name: 'Footer Btn' }],
      children: [
        { id: 'page-1', title: 'Child Page', type: 'page', sections: { content: [] } },
        {
          id: 'group-2',
          title: 'Nested Area',
          type: 'page-group',
          children: [],
        } as PageGroupConfig,
      ],
    };
    const taken = new Set(['group-1', 'page-1', 'group-2', 'h1', 'f1']);

    const result = regenerateIds({ kind: 'page-group', node: group }, taken) as {
      kind: 'page-group';
      node: PageGroupConfig;
    };

    expect(result.node.id).not.toBe('group-1');
    expect(result.node.header?.[0].id).not.toBe('h1');
    expect(result.node.footer?.[0].id).not.toBe('f1');
    expect(result.node.children).toHaveLength(2);
    expect(result.node.children[0].id).not.toBe('page-1');
    expect(result.node.children[1].id).not.toBe('group-2');
  });

  it('assigns a fresh id to a dialog and regenerates its widget ids', () => {
    const dialog: DialogConfig = {
      id: 'dialog-1',
      title: 'Confirm',
      widgets: [{ id: 'w1', type: 'Button', name: 'Confirm' }],
    };
    const taken = new Set(['dialog-1']);

    const result = regenerateIds({ kind: 'dialog', node: dialog }, taken) as {
      kind: 'dialog';
      node: DialogConfig;
    };

    expect(result.node.id).not.toBe('dialog-1');
    expect(result.node.widgets[0].id).not.toBe('w1');
  });
});

describe('multi-node clipboard payloads', () => {
  const widgets: WidgetConfig[] = [
    { id: 'w1', type: 'Button', name: 'One' },
    { id: 'w2', type: 'Button', name: 'Two' },
  ];
  const multi = {
    kind: 'multi' as const,
    nodes: widgets.map((node) => ({ kind: 'widget' as const, node })),
  };

  it('writes an envelope and names the count in the toast', async () => {
    const { writeText } = stubClipboard();

    await copyTreeNode(multi);

    expect(writeText).toHaveBeenCalledWith(JSON.stringify({ $hmiClipboard: 1, nodes: widgets }));
    expect(useHmiStore.getState().pendingToasts[0]).toMatchObject({
      message: 'Copied 2 components',
    });
  });

  it('reads the envelope back as a multi entry', async () => {
    const { readText } = stubClipboard();
    readText.mockResolvedValue(JSON.stringify({ $hmiClipboard: 1, nodes: widgets }));

    expect(await readTreeNodeFromClipboard()).toEqual(multi);
  });

  it('still writes a bare node for a single copy, unchanged', async () => {
    const { writeText } = stubClipboard();

    await copyTreeNode({ kind: 'widget', node: widgets[0] });

    expect(writeText).toHaveBeenCalledWith(JSON.stringify(widgets[0]));
  });

  it('still reads a bare node written by any other build', async () => {
    const { readText } = stubClipboard();
    readText.mockResolvedValue(JSON.stringify(widgets[0]));

    expect(await readTreeNodeFromClipboard()).toEqual({ kind: 'widget', node: widgets[0] });
  });

  it('refuses an envelope holding something that is not a tree node', async () => {
    const { readText } = stubClipboard();
    readText.mockResolvedValue(JSON.stringify({ $hmiClipboard: 1, nodes: [{ nope: true }] }));

    expect(await readTreeNodeFromClipboard()).toBeNull();
    expect(useHmiStore.getState().pendingToasts[0]).toMatchObject({ severity: 'error' });
  });

  it('refuses an envelope whose nodes are not all one kind', async () => {
    const { readText } = stubClipboard();
    const page = { id: 'p1', title: 'Page', type: 'page', sections: { content: [] } };
    readText.mockResolvedValue(JSON.stringify({ $hmiClipboard: 1, nodes: [widgets[0], page] }));

    // Every consumer reads the batch kind off the first node, so a mixed batch
    // would be pasted — and refused — under the wrong node's rules.
    expect(await readTreeNodeFromClipboard()).toBeNull();
    expect(useHmiStore.getState().pendingToasts[0]).toMatchObject({ severity: 'error' });
  });

  it('regenerates every id in a batch against one shared pool', () => {
    const taken = new Set(['w1', 'w2']);

    const result = regenerateIds(multi, taken) as typeof multi;

    const ids = result.nodes.map((n) => n.node.id);
    expect(ids).not.toContain('w1');
    expect(new Set(ids).size).toBe(2);
  });
});

describe('pasteToast', () => {
  it('pushes a toast with the given severity and message', () => {
    pasteToast('error', 'Cannot paste component here');
    expect(useHmiStore.getState().pendingToasts[0]).toMatchObject({
      severity: 'error',
      message: 'Cannot paste component here',
    });
  });
});
