import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiJson } from '@shared/utils/api';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import VideoSourcePicker from './index';

vi.mock('@shared/utils/api', () => ({ apiJson: vi.fn() }));

const ASSETS = [
  { name: 'logo.png', path: 'images/logo.png', type: 'image', size: 2048 },
  { name: 'intro.mp4', path: 'videos/intro.mp4', type: 'video', size: 1536 },
  { name: 'line.webm', path: 'videos/Line One/line.webm', type: 'video', size: 3 * 1024 * 1024 },
];

function openPicker(onPick: (value: { path: string }) => void) {
  act(() => {
    useEditorDomainStore.getState().openAssetPicker('video', onPick, 'Clip');
  });
}

beforeEach(() => {
  vi.mocked(apiJson).mockResolvedValue(ASSETS);
});

afterEach(() => {
  act(() => useEditorDomainStore.getState().closeAssetPicker());
  cleanup();
  vi.clearAllMocks();
});

describe('VideoSourcePicker', () => {
  it('renders nothing until a video target opens it', () => {
    const { container } = render(<VideoSourcePicker />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists only videos at the current folder, with folder and size', async () => {
    render(<VideoSourcePicker />);
    openPicker(vi.fn());

    expect(await screen.findByText('intro.mp4')).toBeInTheDocument();
    expect(screen.getByText('1.5 KB')).toBeInTheDocument();
    // a nested clip stays behind its folder row, and images never appear at all
    expect(screen.queryByText('line.webm')).not.toBeInTheDocument();
    expect(screen.queryByText('logo.png')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Line One/ })).toBeInTheDocument();
  });

  it('drills into a folder and shows the clip inside it', async () => {
    render(<VideoSourcePicker />);
    openPicker(vi.fn());

    await userEvent.click(await screen.findByRole('button', { name: /Line One/ }));

    expect(screen.getByText('line.webm')).toBeInTheDocument();
    expect(screen.getByText('3.0 MB')).toBeInTheDocument();
  });

  it('emits a bare VideoValue and closes on confirm', async () => {
    const onPick = vi.fn();
    render(<VideoSourcePicker />);
    openPicker(onPick);

    await userEvent.click(await screen.findByRole('button', { name: /intro\.mp4/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(onPick).toHaveBeenCalledWith({ path: 'videos/intro.mp4' });
    await waitFor(() => expect(useEditorDomainStore.getState().assetPickerOpen).toBe(false));
  });
});
