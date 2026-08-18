import { describe, expect, it } from 'vitest';
import type { AllAreas } from '@shared/store/configStoreHelpers';
import type { WidgetConfig } from '@shared/types/config';
import { makePageSectionId } from '@shared/constants/editorSentinels';
import { resolvePreviewInsertTarget } from './previewInsertTarget';

const button = (id: string): WidgetConfig => ({ id, type: 'Button', name: id, properties: {} });

const container: WidgetConfig = {
  id: 'box',
  type: 'Container',
  name: 'Box',
  properties: {},
  children: [button('inner')],
};

function project(overrides: Partial<AllAreas> = {}): AllAreas {
  return {
    header: [button('head-btn')],
    footer: [],
    leftSidebar: [],
    rightSidebar: [],
    pages: [
      {
        id: 'page1',
        type: 'page',
        title: 'Home',
        sections: { content: [container, button('loose')] },
      },
    ],
    dialogs: [{ id: 'dlg', title: 'Confirm', widgets: [button('dlg-btn')] }],
    ...overrides,
  };
}

describe('resolvePreviewInsertTarget', () => {
  it('targets a container that was right-clicked directly', () => {
    expect(resolvePreviewInsertTarget(project(), 'box', 'page1')).toEqual({
      kind: 'container',
      nodeId: 'box',
      name: 'Box',
    });
  });

  it('targets the container holding a right-clicked leaf widget', () => {
    expect(resolvePreviewInsertTarget(project(), 'inner', 'page1')).toEqual({
      kind: 'container',
      nodeId: 'box',
      name: 'Box',
    });
  });

  it('targets the page section holding a leaf widget placed straight on the page', () => {
    expect(resolvePreviewInsertTarget(project(), 'loose', 'page1')).toEqual({
      kind: 'page-section',
      nodeId: makePageSectionId('page1', 'content'),
      name: 'Home',
    });
  });

  it('targets the shell area holding a leaf widget in the header', () => {
    expect(resolvePreviewInsertTarget(project(), 'head-btn', 'page1')).toEqual({
      kind: 'area',
      nodeId: 'header',
      name: 'Header',
    });
  });

  it('targets the dialog holding a leaf widget inside it', () => {
    expect(resolvePreviewInsertTarget(project(), 'dlg-btn', 'dlg')).toEqual({
      kind: 'dialog-page',
      nodeId: 'dlg',
      name: 'Confirm',
    });
  });

  it('falls back to the page the preview is showing when nothing was hit', () => {
    expect(resolvePreviewInsertTarget(project(), null, 'page1')).toEqual({
      kind: 'page',
      nodeId: 'page1',
      name: 'Home',
    });
  });

  it('falls back to the shell area the preview is showing', () => {
    expect(resolvePreviewInsertTarget(project(), null, '__leftSidebar__')).toEqual({
      kind: 'area',
      nodeId: 'leftSidebar',
      name: 'Left Sidebar',
    });
  });

  it('has no target when neither the click nor the preview area resolves', () => {
    expect(resolvePreviewInsertTarget(project(), 'ghost', 'ghost-area')).toBeNull();
  });
});
