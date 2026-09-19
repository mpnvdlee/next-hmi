import '../../testSdk';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PreviewContext } from '@shared/context/PreviewContext';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { __resetForTests } from '@hmi/utils/actionDispatcher';
import { useHmiStore } from '@hmi/store/hmiStore';
import { useVariableStore } from '@hmi/store/variableStore';
import Video from './index';

vi.mock('@hmi/hooks/useWebSocket', () => ({
  sendWsMessage: vi.fn(),
}));

// useEvalContext() pulls in useUsersData(), which fetches /api/users and
// resolves asynchronously after mount — a real network call in jsdom, with
// nothing to answer it. Stub it so every render settles synchronously
// instead of leaving a rejected fetch to update state after the test body
// has already returned.
vi.mock('@hmi/hooks/useUsersData', () => ({
  useUsersData: () => [],
}));

// jsdom implements neither of these — stub them locally rather than in the
// shared test-setup, which is deliberately kept free of SDK/app stubs.
let playMock: ReturnType<typeof vi.fn>;
let pauseMock: ReturnType<typeof vi.fn>;
let decodingInfoMock: ReturnType<typeof vi.fn>;
let canPlayTypeMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  __resetForTests();
  useHmiStore.setState({ openPageOverlays: [], pendingToasts: [] });
  useVariableStore.setState({ values: {}, varMeta: {} });

  playMock = vi.fn().mockResolvedValue(undefined);
  pauseMock = vi.fn();
  Object.defineProperty(window.HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: playMock,
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    value: pauseMock,
  });

  // jsdom's own canPlayType answers '' for everything; the stub starts there so
  // only a test that overrides it sees anything else.
  canPlayTypeMock = vi.fn().mockReturnValue('');
  Object.defineProperty(window.HTMLMediaElement.prototype, 'canPlayType', {
    configurable: true,
    value: canPlayTypeMock,
  });

  decodingInfoMock = vi.fn().mockResolvedValue({ supported: true, powerEfficient: true });
  Object.defineProperty(window.navigator, 'mediaCapabilities', {
    configurable: true,
    value: { decodingInfo: decodingInfoMock },
  });
});

afterEach(() => {
  __resetForTests();
});

function videoTree(properties: Record<string, unknown>, preview = false) {
  return (
    <MemoryRouter>
      <PreviewContext.Provider value={preview}>
        <Video properties={properties} />
      </PreviewContext.Provider>
    </MemoryRouter>
  );
}

function renderVideo(properties: Record<string, unknown>, preview = false) {
  return render(videoTree(properties, preview));
}

// The codec probe resolves through two awaits before it lands in state. Drain
// the microtask queue so a "the panel stayed away" assertion is made against
// the settled verdict rather than against a probe still in flight.
async function settleProbes() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const WRITE_ON_ERROR = {
  onError: [{ type: 'writeDataVariable', datasource: 'plc', path: 'Video.Failed', value: true }],
};

describe('Video', () => {
  it('renders a source with the resolved src and the codec type', async () => {
    const { container } = renderVideo({
      sourceMode: 'url',
      url: '/assets/videos/plant.mp4',
      codec: 'h264',
    });

    const source = container.querySelector('source');
    expect(source).toHaveAttribute('src', '/assets/videos/plant.mp4');
    expect(source).toHaveAttribute('type', 'video/mp4; codecs="avc1.42E01E"');

    await waitFor(() => expect(decodingInfoMock).toHaveBeenCalled());
  });

  it('roots a bound asset path under /assets, the way a $static payload arrives', async () => {
    // A $var or $urlParam on the asset field delivers the stored path verbatim;
    // in `src` a project-relative one would resolve against the page url.
    const { container } = renderVideo({
      sourceMode: 'asset',
      asset: 'videos/plant.mp4',
      codec: 'h264',
    });

    expect(container.querySelector('source')).toHaveAttribute('src', '/assets/videos/plant.mp4');

    await waitFor(() => expect(decodingInfoMock).toHaveBeenCalled());
  });

  it('leaves an already-resolved asset url alone', async () => {
    const { container } = renderVideo({
      sourceMode: 'asset',
      asset: '/assets/videos/plant.mp4',
      codec: 'h264',
    });

    expect(container.querySelector('source')).toHaveAttribute('src', '/assets/videos/plant.mp4');

    await waitFor(() => expect(decodingInfoMock).toHaveBeenCalled());
  });

  it('roots a bound poster path under /assets too', async () => {
    const { container } = renderVideo({
      sourceMode: 'url',
      url: '/assets/videos/plant.mp4',
      codec: 'h264',
      poster: 'images/plant-still.png',
    });

    expect(container.querySelector('video')).toHaveAttribute(
      'poster',
      '/assets/images/plant-still.png',
    );

    await waitFor(() => expect(decodingInfoMock).toHaveBeenCalled());
  });

  it('leaves an already-resolved poster url alone', async () => {
    const { container } = renderVideo({
      sourceMode: 'url',
      url: '/assets/videos/plant.mp4',
      codec: 'h264',
      poster: { $static: { path: 'images/plant-still.png' } },
    });

    expect(container.querySelector('video')).toHaveAttribute(
      'poster',
      '/assets/images/plant-still.png',
    );

    await waitFor(() => expect(decodingInfoMock).toHaveBeenCalled());
  });

  it('shows a placeholder when no source is configured', () => {
    const { container } = renderVideo({});

    expect(screen.getByText('No video')).toBeInTheDocument();
    expect(container.querySelector('video')).not.toBeInTheDocument();
  });

  it('shows the diagnostics panel when every declared source probes as unsupported', async () => {
    decodingInfoMock.mockResolvedValue({ supported: false });

    const { container } = renderVideo({
      sourceMode: 'url',
      url: '/assets/videos/plant.mp4',
      codec: 'hevc',
      showDiagnostics: true,
    });

    await waitFor(() => {
      expect(screen.getByText('Video playback not supported')).toBeInTheDocument();
    });
    expect(container.querySelector('video')).toBeInTheDocument();
  });

  it('forces muted when autoplay is on', () => {
    const { container } = renderVideo({
      sourceMode: 'url',
      url: '/assets/videos/plant.mp4',
      autoplay: true,
      muted: false,
    });

    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video.muted).toBe(true);
  });

  it('applies the fit property to the video element', () => {
    const { container } = renderVideo({
      sourceMode: 'url',
      url: '/assets/videos/plant.mp4',
      fit: 'cover',
    });

    const video = container.querySelector('video');
    expect(video).toHaveClass('hmi-video__el--fit-cover');
  });

  it('fires the onEnded action when playback ends', () => {
    const { container } = renderVideo({
      sourceMode: 'url',
      url: '/assets/videos/plant.mp4',
      onEnded: { onEnded: [{ type: 'openPageOverlay', pageId: 'end-of-video' }] },
    });

    const video = container.querySelector('video') as HTMLVideoElement;
    fireEvent(video, new Event('ended'));

    expect(useHmiStore.getState().openPageOverlays.map((o) => o.pageId)).toContain('end-of-video');
  });

  it('does not send a websocket write for an unbound state variable', () => {
    const { container } = renderVideo({
      sourceMode: 'url',
      url: '/assets/videos/plant.mp4',
    });

    const video = container.querySelector('video') as HTMLVideoElement;
    fireEvent(video, new Event('ended'));

    expect(sendWsMessage).not.toHaveBeenCalled();
  });

  it('keeps the video when an auto-codec primary can play and the HEVC fallback cannot', async () => {
    decodingInfoMock.mockResolvedValue({ supported: false });

    const { container } = renderVideo({
      sourceMode: 'url',
      url: '/assets/videos/plant.mp4',
      fallbackMode: 'url',
      fallbackUrl: '/assets/videos/plant-hevc.mp4',
      fallbackCodec: 'hevc',
    });

    // Only the explicit fallback is probed; `auto` is never asked about.
    await waitFor(() => expect(decodingInfoMock).toHaveBeenCalledTimes(1));
    await settleProbes();

    expect(screen.queryByText('Video playback not supported')).not.toBeInTheDocument();
    expect(container.querySelector('video')).toBeInTheDocument();
    expect(container.querySelectorAll('source')).toHaveLength(2);
  });

  it('keeps the video when the HEVC primary is unsupported and the fallback is auto', async () => {
    decodingInfoMock.mockResolvedValue({ supported: false });

    const { container } = renderVideo({
      sourceMode: 'url',
      url: '/assets/videos/plant-hevc.mp4',
      codec: 'hevc',
      fallbackMode: 'url',
      fallbackUrl: '/assets/videos/plant.mp4',
    });

    await waitFor(() => expect(decodingInfoMock).toHaveBeenCalledTimes(1));
    await settleProbes();

    expect(screen.queryByText('Video playback not supported')).not.toBeInTheDocument();
    expect(container.querySelector('video')).toBeInTheDocument();
  });

  it('shows the diagnostics panel when both declared sources probe as unsupported', async () => {
    decodingInfoMock.mockResolvedValue({ supported: false });

    const { container } = renderVideo({
      sourceMode: 'url',
      url: '/assets/videos/plant-hevc.mp4',
      codec: 'hevc',
      fallbackMode: 'url',
      fallbackUrl: '/assets/videos/plant.webm',
      fallbackCodec: 'vp9',
      showDiagnostics: true,
    });

    await waitFor(() => {
      expect(screen.getByText('Video playback not supported')).toBeInTheDocument();
    });
    expect(container.querySelector('video')).toBeInTheDocument();
  });

  it('fires the onError action once and shows diagnostics when every candidate source fails', async () => {
    const { container } = renderVideo({
      sourceMode: 'url',
      url: '/assets/videos/missing.mp4',
      fallbackMode: 'url',
      fallbackUrl: '/assets/videos/missing-too.mp4',
      showDiagnostics: true,
      onError: WRITE_ON_ERROR,
    });

    const candidates = Array.from(container.querySelectorAll('source'));
    expect(candidates).toHaveLength(2);

    fireEvent(candidates[0], new Event('error'));
    expect(screen.queryByText('Video playback not supported')).not.toBeInTheDocument();
    expect(sendWsMessage).not.toHaveBeenCalled();

    fireEvent(candidates[1], new Event('error'));

    await waitFor(() => {
      expect(screen.getByText('Video playback not supported')).toBeInTheDocument();
    });
    expect(container.querySelector('video')).toBeInTheDocument();
    expect(sendWsMessage).toHaveBeenCalledTimes(1);
  });

  it('does not re-fire the onError action when a failed source errors again', () => {
    const { container } = renderVideo({
      sourceMode: 'url',
      url: '/assets/videos/missing.mp4',
      fallbackMode: 'url',
      fallbackUrl: '/assets/videos/missing-too.mp4',
      showDiagnostics: false,
      onError: WRITE_ON_ERROR,
    });

    const candidates = Array.from(container.querySelectorAll('source'));
    candidates.forEach((candidate) => fireEvent(candidate, new Event('error')));
    expect(sendWsMessage).toHaveBeenCalledTimes(1);

    // The element stays mounted however a failure is displayed, so the browser
    // can keep reporting on the same dead candidates.
    candidates.forEach((candidate) => fireEvent(candidate, new Event('error')));
    expect(sendWsMessage).toHaveBeenCalledTimes(1);
    expect(container.querySelector('video')).toBeInTheDocument();
  });

  it('reapplies the playback rate and volume to the element a source change remounts', () => {
    const props = (url: string) => ({
      sourceMode: 'url',
      url,
      playbackRate: 1.5,
      volume: 0.2,
    });

    const { container, rerender } = renderVideo(props('/assets/videos/a.mp4'));
    const first = container.querySelector('video') as HTMLVideoElement;
    expect(first.playbackRate).toBe(1.5);
    expect(first.volume).toBeCloseTo(0.2);

    rerender(videoTree(props('/assets/videos/b.mp4')));
    const second = container.querySelector('video') as HTMLVideoElement;

    expect(second).not.toBe(first);
    expect(second.playbackRate).toBe(1.5);
    expect(second.volume).toBeCloseTo(0.2);
  });

  it('plays again on the element a source change remounts while playWhen is true', () => {
    const props = (url: string) => ({ sourceMode: 'url', url, playWhen: true });

    const { rerender } = renderVideo(props('/assets/videos/a.mp4'));
    expect(playMock).toHaveBeenCalledTimes(1);

    rerender(videoTree(props('/assets/videos/b.mp4')));

    expect(playMock).toHaveBeenCalledTimes(2);
  });

  it('does not start playback in the editor preview', () => {
    renderVideo({ sourceMode: 'url', url: '/assets/videos/a.mp4', playWhen: true }, true);

    expect(playMock).not.toHaveBeenCalled();
  });

  it('remounts the element when only the codec changes', async () => {
    const { container, rerender } = renderVideo({
      sourceMode: 'url',
      url: '/assets/videos/plant.mp4',
      codec: 'h264',
    });
    const first = container.querySelector('video');

    rerender(videoTree({ sourceMode: 'url', url: '/assets/videos/plant.mp4', codec: 'hevc' }));

    expect(container.querySelector('video')).not.toBe(first);
    expect(container.querySelector('source')).toHaveAttribute(
      'type',
      'video/mp4; codecs="hvc1.1.6.L93.B0"',
    );
    await settleProbes();
  });

  it('clamps a volume and a playback rate a binding pushed outside the schema range', () => {
    const high = renderVideo({
      sourceMode: 'url',
      url: '/assets/videos/a.mp4',
      volume: 80,
      playbackRate: 16,
    });
    const highVideo = high.container.querySelector('video') as HTMLVideoElement;
    expect(highVideo.volume).toBe(1);
    expect(highVideo.playbackRate).toBe(4);

    const low = renderVideo({
      sourceMode: 'url',
      url: '/assets/videos/b.mp4',
      volume: -5,
      playbackRate: -2,
    });
    const lowVideo = low.container.querySelector('video') as HTMLVideoElement;
    expect(lowVideo.volume).toBe(0);
    expect(lowVideo.playbackRate).toBe(0.25);
  });

  it('falls back to the schema default for a non-finite volume binding', () => {
    const { container } = renderVideo({
      sourceMode: 'url',
      url: '/assets/videos/a.mp4',
      volume: Number.POSITIVE_INFINITY,
    });

    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video.volume).toBe(1);
  });

  it('keeps the element mounted whether the diagnostics panel is shown or hidden', async () => {
    decodingInfoMock.mockResolvedValue({ supported: false });
    const props = (showDiagnostics: boolean) => ({
      sourceMode: 'url',
      url: '/assets/videos/plant-hevc.mp4',
      codec: 'hevc',
      showDiagnostics,
    });

    const { container, rerender } = renderVideo(props(true));
    await waitFor(() => {
      expect(screen.getByText('Video playback not supported')).toBeInTheDocument();
    });
    const shown = container.querySelector('video');
    expect(shown).toBeInTheDocument();

    rerender(videoTree(props(false)));
    await settleProbes();

    expect(screen.queryByText('Video playback not supported')).not.toBeInTheDocument();
    expect(container.querySelector('video')).toBe(shown);
  });

  it('does not veto a source decodingInfo refuses but canPlayType accepts', async () => {
    decodingInfoMock.mockResolvedValue({ supported: false });
    canPlayTypeMock.mockReturnValue('probably');

    const { container } = renderVideo({
      sourceMode: 'url',
      url: '/assets/videos/plant-hevc.mp4',
      codec: 'hevc',
      onError: WRITE_ON_ERROR,
    });

    await waitFor(() => expect(decodingInfoMock).toHaveBeenCalledTimes(1));
    await settleProbes();

    expect(screen.queryByText('Video playback not supported')).not.toBeInTheDocument();
    expect(container.querySelector('video')).toBeInTheDocument();
    expect(sendWsMessage).not.toHaveBeenCalled();
  });

  it('plays a fallback-only configuration as the sole source', async () => {
    const { container } = renderVideo({
      fallbackMode: 'url',
      fallbackUrl: '/assets/videos/fallback.mp4',
      fallbackCodec: 'h264',
    });

    expect(screen.queryByText('No video')).not.toBeInTheDocument();
    expect(container.querySelector('video')).toBeInTheDocument();
    const candidates = container.querySelectorAll('source');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toHaveAttribute('src', '/assets/videos/fallback.mp4');
    expect(candidates[0]).toHaveAttribute('type', 'video/mp4; codecs="avc1.42E01E"');

    await settleProbes();
  });

  it('clears a stranded tap overlay once a bound playWhen resolves true', async () => {
    // Mirrors the reachable sequence: autoplay's play() is still pending when
    // playWhen's fallback (the bound variable hasn't arrived) calls pause(),
    // which a real browser answers by rejecting the pending play with
    // AbortError.
    playMock.mockRejectedValueOnce(
      new DOMException('The play() request was interrupted by a call to pause()', 'AbortError'),
    );

    const properties = {
      sourceMode: 'url',
      url: '/assets/videos/plant.mp4',
      autoplay: true,
      playWhen: { $var: { path: 'PLC:Run' } },
    };

    const { rerender } = renderVideo(properties);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Tap to play' })).toBeInTheDocument();
    });
    expect(pauseMock).toHaveBeenCalled();

    useVariableStore.setState({ values: { 'PLC:Run': true } });
    rerender(videoTree(properties));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Tap to play' })).not.toBeInTheDocument();
    });
  });
});
