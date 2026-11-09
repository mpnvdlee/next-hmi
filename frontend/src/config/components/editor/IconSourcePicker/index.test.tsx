import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiJson } from '@shared/utils/api';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import IconSourcePicker from './index';

vi.mock('@shared/utils/api', () => ({ apiJson: vi.fn() }));

const ASSETS = [{ name: 'pump.svg', path: 'icons/pump.svg', type: 'icon', size: 512 }];

beforeEach(() => {
  vi.mocked(apiJson).mockResolvedValue(ASSETS);
});

afterEach(() => {
  act(() => useEditorDomainStore.getState().closeAssetPicker());
  cleanup();
  vi.clearAllMocks();
});

describe('IconSourcePicker', () => {
  it('previews a custom icon as the widgets draw it, under its file name', async () => {
    render(<IconSourcePicker />);
    act(() => {
      useEditorDomainStore.getState().openAssetPicker('icon', vi.fn(), 'Icon');
    });

    await userEvent.click(screen.getByRole('tab', { name: 'Custom' }));
    const tile = await screen.findByRole('button', { name: 'pump.svg' });

    // A mask in the text colour, not an image in the file's own colours.
    expect(tile.querySelector('img')).toBeNull();
    const glyph = tile.querySelector('.cfg-custom-icon');
    expect(glyph).not.toBeNull();
    expect((glyph as HTMLElement).style.getPropertyValue('--cfg-custom-icon-url')).toBe(
      'url("/assets/icons/pump.svg")',
    );

    await userEvent.click(tile);
    expect(document.querySelector('.cfg-asset-picker-selection .cfg-custom-icon')).not.toBeNull();
  });
});
