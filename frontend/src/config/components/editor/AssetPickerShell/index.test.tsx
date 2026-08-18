import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AssetPickerShell from './index';

afterEach(cleanup);

function renderPicker(onConfirm: () => void, confirmDisabled = false, onSearchEnter?: () => void) {
  render(
    <AssetPickerShell
      title="Icon"
      action="Select icon"
      onClose={() => {}}
      onConfirm={onConfirm}
      confirmDisabled={confirmDisabled}
      search=""
      onSearchChange={() => {}}
      onSearchEnter={onSearchEnter}
      selectionPreview={<span>Nothing selected</span>}
    >
      <div>Icons</div>
    </AssetPickerShell>,
  );
}

describe('AssetPickerShell', () => {
  it('confirms with Enter while the search field is focused', () => {
    const onConfirm = vi.fn();
    renderPicker(onConfirm);

    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search select icon' }), {
      key: 'Enter',
    });

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('does not confirm with Enter when confirmation is disabled', () => {
    const onConfirm = vi.fn();
    renderPicker(onConfirm, true);

    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search select icon' }), {
      key: 'Enter',
    });

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('uses the picker-specific search Enter action when provided', () => {
    const onConfirm = vi.fn();
    const onSearchEnter = vi.fn();
    renderPicker(onConfirm, true, onSearchEnter);

    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search select icon' }), {
      key: 'Enter',
    });

    expect(onSearchEnter).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
