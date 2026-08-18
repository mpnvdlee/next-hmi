import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import type { ComponentDefinition } from '@shared/types/componentTypes';
import CompositionSchemaEditor from './CompositionSchemaEditor';

const component: ComponentDefinition = {
  id: 'line-meter',
  name: 'Line Meter',
  componentProperties: {},
  children: [],
};

afterEach(() => {
  cleanup();
  useEditorDomainStore.getState().closeAssetPicker();
});

describe('CompositionSchemaEditor', () => {
  it('uses the shared icon picker and stores its structured selection', () => {
    const onUpdate = vi.fn();
    render(<CompositionSchemaEditor component={component} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByText('Icon'));
    fireEvent.click(screen.getByTitle('Choose icon'));

    const target = useEditorDomainStore.getState().assetPickerTarget;
    expect(target?.type).toBe('icon');
    if (target?.type !== 'icon') throw new Error('Icon picker did not open');

    target.onPick({ type: 'custom', path: 'icons/line-meter.svg' });
    expect(onUpdate).toHaveBeenCalledWith({
      icon: { type: 'custom', path: 'icons/line-meter.svg' },
    });
  });

  it('previews a custom icon selection', () => {
    const { container } = render(
      <CompositionSchemaEditor
        component={{ ...component, icon: { type: 'custom', path: 'icons/line-meter.svg' } }}
        onUpdate={() => {}}
      />,
    );

    fireEvent.click(screen.getByText('Icon'));
    expect(container.querySelector('img')?.getAttribute('src')).toContain(
      '/assets/icons/line-meter.svg',
    );
  });
});
