/* @jsxRuntime classic */
export const schema = {
  sourceMode: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Source',
    group: 'Content',
    defaultValue: 'asset',
    options: [
      { label: 'Asset', value: 'asset' },
      { label: 'URL', value: 'url' },
    ],
  },
  asset: {
    type: 'video' as const,
    label: 'Video asset',
    group: 'Content',
    visibleWhen: { property: 'sourceMode', equals: 'asset' },
  },
  url: {
    type: 'string' as const,
    label: 'Video URL',
    group: 'Content',
    visibleWhen: { property: 'sourceMode', equals: 'url' },
  },
  codec: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Codec',
    group: 'Content',
    defaultValue: 'auto',
    options: [
      { label: 'Auto', value: 'auto' },
      { label: 'H.264 (AVC)', value: 'h264' },
      { label: 'HEVC (H.265)', value: 'hevc' },
      { label: 'VP9', value: 'vp9' },
      { label: 'AV1', value: 'av1' },
    ],
  },
  codecString: {
    type: 'string' as const,
    label: 'Codec string override',
    group: 'Content',
    placeholder: 'e.g. hvc1.1.6.L93.B0',
    description: 'Overrides the codecs parameter emitted for the chosen codec preset.',
    visibleWhen: { property: 'codec', notEquals: 'auto' },
  },

  fallbackMode: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Fallback source',
    group: 'Content',
    defaultValue: 'asset',
    options: [
      { label: 'Asset', value: 'asset' },
      { label: 'URL', value: 'url' },
    ],
  },
  fallbackAsset: {
    type: 'video' as const,
    label: 'Fallback video asset',
    group: 'Content',
    visibleWhen: { property: 'fallbackMode', equals: 'asset' },
  },
  fallbackUrl: {
    type: 'string' as const,
    label: 'Fallback video URL',
    group: 'Content',
    visibleWhen: { property: 'fallbackMode', equals: 'url' },
  },
  fallbackCodec: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Fallback codec',
    group: 'Content',
    defaultValue: 'auto',
    options: [
      { label: 'Auto', value: 'auto' },
      { label: 'H.264 (AVC)', value: 'h264' },
      { label: 'HEVC (H.265)', value: 'hevc' },
      { label: 'VP9', value: 'vp9' },
      { label: 'AV1', value: 'av1' },
    ],
  },
  fallbackCodecString: {
    type: 'string' as const,
    label: 'Fallback codec string override',
    group: 'Content',
    placeholder: 'e.g. avc1.640028',
    description: 'Overrides the codecs parameter emitted for the fallback codec preset.',
    visibleWhen: { property: 'fallbackCodec', notEquals: 'auto' },
  },

  poster: { type: 'image' as const, label: 'Poster image', group: 'Content' },

  autoplay: {
    type: 'boolean' as const,
    label: 'Autoplay',
    group: 'Playback',
    defaultValue: false,
    description: 'Forces the video muted — browsers block unmuted autoplay.',
  },
  muted: { type: 'boolean' as const, label: 'Muted', group: 'Playback', defaultValue: true },
  loop: { type: 'boolean' as const, label: 'Loop', group: 'Playback', defaultValue: false },
  controls: {
    type: 'boolean' as const,
    label: 'Show controls',
    group: 'Playback',
    defaultValue: true,
  },
  playsInline: {
    type: 'boolean' as const,
    label: 'Play inline',
    group: 'Playback',
    defaultValue: true,
  },
  preload: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Preload',
    group: 'Playback',
    defaultValue: 'metadata',
    options: [
      { label: 'None', value: 'none' },
      { label: 'Metadata', value: 'metadata' },
      { label: 'Auto', value: 'auto' },
    ],
  },
  playbackRate: {
    type: 'float' as const,
    label: 'Playback rate',
    group: 'Playback',
    min: 0.25,
    max: 4,
    step: 0.25,
    defaultValue: 1,
  },
  volume: {
    type: 'float' as const,
    label: 'Volume',
    group: 'Playback',
    min: 0,
    max: 1,
    step: 0.05,
    defaultValue: 1,
  },
  pauseWhenHidden: {
    type: 'boolean' as const,
    label: 'Pause when hidden',
    group: 'Playback',
    defaultValue: true,
    description: 'Pauses playback when the browser tab is hidden. Does not auto-resume.',
  },

  fit: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Fit',
    group: 'Appearance',
    defaultValue: 'contain',
    options: [
      { label: 'Contain', value: 'contain' },
      { label: 'Cover', value: 'cover' },
      { label: 'Fill', value: 'fill' },
      { label: 'None', value: 'none' },
      { label: 'Scale down', value: 'scale-down' },
    ],
  },
  backgroundColor: {
    type: 'color' as const,
    label: 'Background color',
    group: 'Appearance',
    defaultToken: '--hmi-bg',
  },
  cornerRadius: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Corner radius',
    group: 'Appearance',
    defaultValue: 'none',
    options: [
      { label: 'None', value: 'none' },
      { label: 'Small', value: 'sm' },
      { label: 'Medium', value: 'md' },
      { label: 'Large', value: 'lg' },
    ],
  },
  borderStyle: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Border',
    group: 'Appearance',
    defaultValue: 'none',
    options: [
      { label: 'None', value: 'none' },
      { label: 'Subtle', value: 'subtle' },
      { label: 'Strong', value: 'strong' },
    ],
  },
  showDiagnostics: {
    type: 'boolean' as const,
    label: 'Show diagnostics',
    group: 'Appearance',
    defaultValue: false,
    description:
      'Authoring aid: explains an unsupported codec instead of showing a blank frame. Off by default so an operator never meets a codec probe table.',
  },

  playWhen: {
    type: 'boolean' as const,
    label: 'Play when',
    group: 'Data',
    description: 'Plays while true, pauses while false. Left unbound, playback is manual.',
  },
  stateVariable: {
    type: 'string' as const,
    label: 'State variable',
    group: 'Data',
    write: true,
    description: 'Writes "playing", "paused" or "ended" as playback state changes.',
  },
  currentTimeVariable: {
    type: 'string' as const,
    label: 'Current time variable',
    group: 'Data',
    write: true,
    description: 'Writes the current playback position in seconds, throttled to once/second.',
  },

  onPlay: { type: 'actions' as const, label: 'On Play', group: 'Actions', event: 'onPlay' },
  onPause: { type: 'actions' as const, label: 'On Pause', group: 'Actions', event: 'onPause' },
  onEnded: { type: 'actions' as const, label: 'On Ended', group: 'Actions', event: 'onEnded' },
  onError: { type: 'actions' as const, label: 'On Error', group: 'Actions', event: 'onError' },
};

export const description = 'Plays a recorded video from a project asset or a URL.';
export const category = 'Content & controls';
export const icon = { type: 'builtin', name: 'play' } as const;

type Codec = 'auto' | 'h264' | 'hevc' | 'vp9' | 'av1';
type Role = 'primary' | 'fallback';
type ProbeStatus = 'supported' | 'unsupported' | 'unknown';

interface ProbeResult {
  status: ProbeStatus;
  powerEfficient?: boolean;
}

interface ResolvedSource {
  role: Role;
  url: string;
  codec: Codec;
  type: string | undefined;
}

/** Everything learned about the current source list, tagged with the list it was
 *  learned for. A render that sees another tag reads the whole lot as unknown, so
 *  a source change is never judged on the previous list's verdicts — and can
 *  never re-fire On Error for them. */
interface SourceVerdicts {
  key: string;
  probes: Partial<Record<Role, ProbeResult>>;
  failed: Partial<Record<Role, boolean>>;
  mediaErrored: boolean;
  mediaErrorCode: number | null;
}

const NO_VERDICTS: SourceVerdicts = {
  key: '',
  probes: {},
  failed: {},
  mediaErrored: false,
  mediaErrorCode: null,
};

const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;
const NETWORK_NO_SOURCE = 3;

const CODEC_PRESETS: Record<Exclude<Codec, 'auto'>, { mime: string; codecs: string }> = {
  h264: { mime: 'video/mp4', codecs: 'avc1.42E01E' },
  hevc: { mime: 'video/mp4', codecs: 'hvc1.1.6.L93.B0' },
  vp9: { mime: 'video/webm', codecs: 'vp09.00.10.08' },
  av1: { mime: 'video/mp4', codecs: 'av01.0.05M.08' },
};

function extensionMime(url: string): string | undefined {
  const clean = url.split(/[?#]/)[0];
  const dot = clean.lastIndexOf('.');
  if (dot === -1) return undefined;
  const ext = clean.slice(dot + 1).toLowerCase();
  if (ext === 'mp4' || ext === 'm4v') return 'video/mp4';
  if (ext === 'webm') return 'video/webm';
  return undefined;
}

function computeSourceType(codec: Codec, codecString: string, url: string): string | undefined {
  if (codec === 'auto') return extensionMime(url);
  const preset = CODEC_PRESETS[codec];
  const codecsValue = codecString.trim() ? codecString.trim() : preset.codecs;
  return `${preset.mime}; codecs="${codecsValue}"`;
}

/* The schema's min and max only bound what the editor accepts as a static
   value; the same property takes a binding, which delivers any number at all.
   Both media setters throw on one out of range — `volume` an IndexSizeError,
   `playbackRate` a NotSupportedError — and a throw inside the effect that
   assigns them hands the whole widget to the error boundary for the rest of the
   session. */
function clampToSchema(
  value: number,
  range: { min: number; max: number; defaultValue: number },
): number {
  if (!Number.isFinite(value)) return range.defaultValue;
  return Math.min(range.max, Math.max(range.min, value));
}

/* Knows nothing about the media but its content type, which is what makes it a
   safe second opinion on `decodingInfo` below. */
function canPlayTypeStatus(contentType: string): ProbeStatus {
  try {
    const probe = document.createElement('video');
    const can = probe.canPlayType(contentType);
    if (can === '') return 'unsupported';
    if (can === 'probably' || can === 'maybe') return 'supported';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

async function probeCodecSupport(contentType: string): Promise<ProbeResult> {
  const capabilities = (navigator as { mediaCapabilities?: MediaCapabilities }).mediaCapabilities;
  if (capabilities && typeof capabilities.decodingInfo === 'function') {
    try {
      const info = await capabilities.decodingInfo({
        type: 'file',
        video: {
          contentType,
          width: 1920,
          height: 1080,
          bitrate: 4_000_000,
          framerate: 30,
        },
      });
      if (info.supported === true)
        return { status: 'supported', powerEfficient: info.powerEfficient };
      /* The profile asked about is a guess, so a `false` may be about the
         resolution or the bitrate rather than the codec — vetoing on it alone
         hides a 480p clip that would have played fine. `canPlayType` has no
         such dimension, so only when it refuses the same type is the source
         really undecodable. */
      if (info.supported === false) {
        return {
          status: canPlayTypeStatus(contentType) === 'unsupported' ? 'unsupported' : 'unknown',
        };
      }
      return { status: 'unknown' };
    } catch {
      // Fall through to canPlayType.
    }
  }
  return { status: canPlayTypeStatus(contentType) };
}

function diagnosticsHint(codec: Codec): string {
  switch (codec) {
    case 'hevc':
      return 'HEVC needs a hardware decoder this browser/OS may not have. If the file is tagged "hev1" instead of "hvc1", Apple browsers refuse it outright — re-mux with the "hvc1" tag. Add an H.264 fallback source for broad compatibility.';
    case 'vp9':
      return 'VP9 needs WebM container support, which Safari lacks. Add an H.264 (MP4) fallback source.';
    case 'av1':
      return 'AV1 decoding is not yet universal — older browsers and low-power devices often lack it. Add an H.264 fallback source.';
    default:
      return 'Add an H.264 (MP4) fallback source for broad compatibility.';
  }
}

/* `play()` returns a promise in every current browser, but the spec allows
   `undefined` and older embedded WebViews still do that — so the verdict has to
   be reported on both paths. `onSettled(true)` means playback was blocked and
   the tap-to-play overlay is owed. */
function attemptPlay(el: HTMLVideoElement, onSettled: (blocked: boolean) => void): void {
  const result = el.play();
  if (result && typeof result.then === 'function') {
    result.then(() => onSettled(false)).catch(() => onSettled(true));
  } else {
    onSettled(false);
  }
}

export default function Video({ properties, layout }: HmiWidgetProps) {
  const scope = useHmiScope();
  const evalCtx = useEvalContext();
  const isPreview = useIsPreview();

  const sourceMode = getPropString(properties, 'sourceMode', 'asset', evalCtx);
  const asset = getPropString(properties, 'asset', '', evalCtx);
  const url = getPropString(properties, 'url', '', evalCtx);
  const codec = getPropString(properties, 'codec', 'auto', evalCtx) as Codec;
  const codecString = getPropString(properties, 'codecString', '', evalCtx);

  const fallbackMode = getPropString(properties, 'fallbackMode', 'asset', evalCtx);
  const fallbackAsset = getPropString(properties, 'fallbackAsset', '', evalCtx);
  const fallbackUrl = getPropString(properties, 'fallbackUrl', '', evalCtx);
  const fallbackCodec = getPropString(properties, 'fallbackCodec', 'auto', evalCtx) as Codec;
  const fallbackCodecString = getPropString(properties, 'fallbackCodecString', '', evalCtx);

  const poster = assetSrc(getPropString(properties, 'poster', '', evalCtx));

  const autoplay = getPropBoolean(properties, 'autoplay', false, evalCtx);
  const muted = getPropBoolean(properties, 'muted', true, evalCtx);
  const loop = getPropBoolean(properties, 'loop', false, evalCtx);
  const controls = getPropBoolean(properties, 'controls', true, evalCtx);
  const playsInline = getPropBoolean(properties, 'playsInline', true, evalCtx);
  const preload = getPropString(properties, 'preload', 'metadata', evalCtx) as 'none' | 'metadata' | 'auto';
  const playbackRate = getPropNumber(properties, 'playbackRate', 1, evalCtx);
  const volume = getPropNumber(properties, 'volume', 1, evalCtx);
  const pauseWhenHidden = getPropBoolean(properties, 'pauseWhenHidden', true, evalCtx);

  const fit = getPropString(properties, 'fit', 'contain', evalCtx);
  const backgroundColor = getPropString(properties, 'backgroundColor', '', evalCtx);
  const cornerRadius = getPropString(properties, 'cornerRadius', 'none', evalCtx);
  const borderStyle = getPropString(properties, 'borderStyle', 'none', evalCtx);
  const showDiagnostics = getPropBoolean(properties, 'showDiagnostics', false, evalCtx);

  const playWhenBool = getPropBoolean(properties, 'playWhen', false, evalCtx);
  const hasPlayWhen = properties?.playWhen !== undefined;
  const writeState = useWriteVariable(properties, 'stateVariable');
  const writeCurrentTime = useWriteVariable(properties, 'currentTimeVariable', { tracked: false });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastTimeWriteRef = useRef(0);
  const errorFiredForRef = useRef<string | null>(null);
  const [needsTap, setNeedsTap] = useState(false);
  const [verdicts, setVerdicts] = useState<SourceVerdicts>(NO_VERDICTS);
  /* The `key` below remounts the media element whenever the source list changes.
     Holding the element in state as well as in the ref is what re-runs the
     imperative effects below against the fresh one — keyed on the props alone
     they never re-run, and the new element keeps the DOM defaults. */
  const [mediaEl, setMediaEl] = useState<HTMLVideoElement | null>(null);

  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    setMediaEl(el);
    if (!el) return;
    /* A panel navigates between pages all day and the `key` below remounts on
       every source change, so an abandoned element is the normal case, not the
       exception. Dropping the sources and re-running selection aborts the
       in-flight fetch and releases the decoder now; left alone it would hold
       both — tens of MB for a 1080p clip — until GC reaches the detached
       fiber. */
    return () => {
      el.pause();
      el.removeAttribute('src');
      while (el.firstChild) el.removeChild(el.firstChild);
      el.load();
    };
  }, []);

  const primarySrc = sourceMode === 'url' ? url : assetSrc(asset);
  const fallbackSrc = fallbackMode === 'url' ? fallbackUrl : assetSrc(fallbackAsset);

  const sources = useMemo<ResolvedSource[]>(() => {
    const list: ResolvedSource[] = [];
    if (primarySrc) {
      list.push({
        role: 'primary',
        url: primarySrc,
        codec,
        type: computeSourceType(codec, codecString, primarySrc),
      });
    }
    if (fallbackSrc) {
      list.push({
        role: 'fallback',
        url: fallbackSrc,
        codec: fallbackCodec,
        type: computeSourceType(fallbackCodec, fallbackCodecString, fallbackSrc),
      });
    }
    return list;
  }, [primarySrc, codec, codecString, fallbackSrc, fallbackCodec, fallbackCodecString]);

  /* Identifies the source list, not just its URLs: changing only the codec
     rewrites `type` and must reload the element too. Doubles as the media
     element's remount key and as the tag on every verdict below. */
  const sourceKey = useMemo(
    () => sources.map((s) => `${s.role}|${s.url}|${s.type ?? ''}`).join('||'),
    [sources],
  );

  useEffect(() => {
    let cancelled = false;
    setVerdicts({ ...NO_VERDICTS, key: sourceKey });
    sources.forEach((source) => {
      if (source.codec === 'auto' || !source.type) return;
      probeCodecSupport(source.type).then((result) => {
        if (cancelled) return;
        setVerdicts((prev) =>
          prev.key === sourceKey
            ? { ...prev, probes: { ...prev.probes, [source.role]: result } }
            : prev,
        );
      });
    });
    return () => {
      cancelled = true;
    };
  }, [sources, sourceKey]);

  const current = verdicts.key === sourceKey ? verdicts : NO_VERDICTS;

  /* A source counts as playable until proven otherwise: `auto` is never probed,
     and an inconclusive probe is not a verdict. Only a probe that came back
     `unsupported` or a candidate the browser actually rejected removes one. */
  const noPlayableSource =
    sources.length > 0 &&
    sources.every(
      (s) => current.failed[s.role] === true || current.probes[s.role]?.status === 'unsupported',
    );
  const playbackFailed = noPlayableSource || current.mediaErrored;

  useEffect(() => {
    if (!playbackFailed || errorFiredForRef.current === sourceKey) return;
    errorFiredForRef.current = sourceKey;
    const actions = properties?.onError as ActionsConfig | undefined;
    executeWidgetActions(actions?.onError, { scope, evalCtx });
  }, [playbackFailed, sourceKey, properties, scope, evalCtx]);

  useEffect(() => {
    if (mediaEl) mediaEl.playbackRate = clampToSchema(playbackRate, schema.playbackRate);
  }, [mediaEl, playbackRate]);

  useEffect(() => {
    if (mediaEl) mediaEl.volume = clampToSchema(volume, schema.volume);
  }, [mediaEl, volume]);

  useEffect(() => {
    setNeedsTap(false);
    if (!autoplay || isPreview || !mediaEl) return;
    const el = mediaEl;
    attemptPlay(el, (blocked) => {
      if (videoRef.current === el) setNeedsTap(blocked);
    });
  }, [autoplay, isPreview, mediaEl]);

  /* `playWhen` toggling false is not a failure to play — it's the widget being
     told to pause — so it must clear `needsTap` itself rather than leave a
     stale `true` from a play() the pause below is about to interrupt. Every
     resolution is also checked against the element it was issued for: a
     source change remounts to a new `mediaEl` before this promise settles,
     and a stale settle must not touch the new element's overlay state. */
  useEffect(() => {
    if (!hasPlayWhen || isPreview || !mediaEl) return;
    const el = mediaEl;
    if (playWhenBool) {
      attemptPlay(el, (blocked) => {
        if (videoRef.current === el) setNeedsTap(blocked);
      });
    } else {
      el.pause();
      setNeedsTap(false);
    }
  }, [hasPlayWhen, isPreview, playWhenBool, mediaEl]);

  useEffect(() => {
    if (!pauseWhenHidden) return;
    function handleVisibility() {
      if (document.hidden) videoRef.current?.pause();
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [pauseWhenHidden]);

  function handleTapToPlay() {
    const el = videoRef.current;
    if (!el) return;
    // The overlay drops either way: leaving it up after the tap it was there to
    // invite would block the widget's own controls for good, so a rejection
    // (an undecodable source, or still-blocked autoplay) is not reported here.
    attemptPlay(el, () => setNeedsTap(false));
  }

  function fire(event: 'onPlay' | 'onPause' | 'onEnded', state: string) {
    writeState(state);
    const actions = properties?.[event] as ActionsConfig | undefined;
    executeWidgetActions(actions?.[event], { scope, evalCtx });
  }

  /* Where a failure is actually reported. With `<source>` children the resource
     selection algorithm fires `error` at each candidate `<source>` and never at
     the media element, leaving `video.error` null — so this, not the element's
     own handler, is what tells the widget a file is missing or undecodable. */
  function handleSourceError(role: Role) {
    setVerdicts((prev) =>
      prev.key === sourceKey && !prev.failed[role]
        ? { ...prev, failed: { ...prev.failed, [role]: true } }
        : prev,
    );
  }

  /* The paths that do populate `video.error`: a source the browser selected and
     then failed to decode, and a `src` attribute rather than `<source>`
     children. Kept as a safety net, not relied on.
     React propagates a candidate's `error` up the fiber tree to this handler
     even though the DOM event does not bubble, so a report that came from a
     `<source>` is left to `handleSourceError` alone — counting it here would
     declare the whole element dead on the first failed candidate. */
  function handleMediaError(event: { target: unknown; currentTarget: unknown }) {
    if (event.target !== event.currentTarget) return;
    const el = videoRef.current;
    const code = el?.error ? el.error.code : null;
    const exhausted =
      code === MEDIA_ERR_SRC_NOT_SUPPORTED || el?.networkState === NETWORK_NO_SOURCE;
    setVerdicts((prev) =>
      prev.key === sourceKey
        ? {
            ...prev,
            mediaErrored: true,
            mediaErrorCode: code,
            failed: exhausted ? { primary: true, fallback: true } : prev.failed,
          }
        : prev,
    );
  }

  function handleTimeUpdate() {
    const el = videoRef.current;
    if (!el) return;
    const now = Date.now();
    if (now - lastTimeWriteRef.current < 1000) return;
    lastTimeWriteRef.current = now;
    writeCurrentTime(el.currentTime);
  }

  const rootClasses = [
    'hmi-component',
    'hmi-video',
    borderStyle !== 'none' ? `hmi-video--border-${borderStyle}` : '',
    cornerRadius !== 'none' ? `hmi-video--radius-${cornerRadius}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const containerStyle: Record<string, string> = {};
  if (backgroundColor) containerStyle['--hmi-video-bg'] = backgroundColor;

  /* A fallback on its own is still something to play: the list is what decides,
     not the primary slot. */
  if (sources.length === 0) {
    return (
      <div
        className={`${rootClasses} hmi-video--empty`}
        style={{ ...selfLayoutStyle(layout), ...containerStyle }}
      >
        <span className="hmi-video__placeholder">No video</span>
      </div>
    );
  }

  /* An overlay, never a replacement: `showDiagnostics` is an Appearance
     property, and swapping the element out for the panel made a display toggle
     decide whether the video played at all. */
  const showDiagnosticsPanel = showDiagnostics && noPlayableSource;
  const anyCandidateFailed = sources.some((s) => current.failed[s.role] === true);

  const softwareDecodeHint = sources.some((s) => {
    const probe = current.probes[s.role];
    return probe?.status === 'supported' && probe.powerEfficient === false;
  });

  const attemptedCodecs = Array.from(
    new Set(sources.map((s) => s.codec).filter((c): c is Exclude<Codec, 'auto'> => c !== 'auto')),
  );
  const diagnosticsHints = (
    attemptedCodecs.length > 0 ? attemptedCodecs : (['auto'] as Codec[])
  ).map(diagnosticsHint);

  const elClasses = ['hmi-video__el', fit !== 'contain' ? `hmi-video__el--fit-${fit}` : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rootClasses} style={{ ...selfLayoutStyle(layout), ...containerStyle }}>
      <div className="hmi-video__body">
        <video
          ref={attachVideo}
          key={sourceKey}
          className={elClasses}
          muted={autoplay || muted}
          loop={loop}
          controls={controls}
          playsInline={playsInline}
          preload={preload}
          poster={poster || undefined}
          onPlay={() => fire('onPlay', 'playing')}
          onPause={() => fire('onPause', 'paused')}
          onEnded={() => fire('onEnded', 'ended')}
          onError={handleMediaError}
          onTimeUpdate={handleTimeUpdate}
        >
          {sources.map((s) => (
            <source
              key={s.role}
              src={s.url}
              type={s.type}
              onError={() => handleSourceError(s.role)}
            />
          ))}
        </video>
        {needsTap && (
          <button type="button" className="hmi-video__tap-overlay" onClick={handleTapToPlay}>
            Tap to play
          </button>
        )}
        {showDiagnostics && softwareDecodeHint && (
          <div className="hmi-video__hint">Software decode (no hardware acceleration)</div>
        )}
        {showDiagnosticsPanel && (
          <div className="hmi-video__diagnostics">
            <span className="hmi-video__diagnostics-title">Video playback not supported</span>
            <ul className="hmi-video__diagnostics-list">
              {sources.map((s) => (
                <li key={s.role} className="hmi-video__diagnostics-item">
                  <span className="hmi-video__diagnostics-role">
                    {s.role === 'primary' ? 'Primary' : 'Fallback'} ({s.codec})
                  </span>
                  <span className="hmi-video__diagnostics-type">
                    {s.type ?? '(unspecified type)'}
                  </span>
                  <span className="hmi-video__diagnostics-status">
                    {current.failed[s.role]
                      ? 'failed'
                      : (current.probes[s.role]?.status ?? 'unknown')}
                  </span>
                </li>
              ))}
            </ul>
            {anyCandidateFailed && (
              <p className="hmi-video__diagnostics-note">
                The browser rejected every source it tried. Check that each file exists, is
                reachable, and is encoded as declared.
              </p>
            )}
            {current.mediaErrorCode === MEDIA_ERR_SRC_NOT_SUPPORTED && (
              <p className="hmi-video__diagnostics-note">
                The browser reported MEDIA_ERR_SRC_NOT_SUPPORTED (code 4): it could not decode any
                offered source.
              </p>
            )}
            {diagnosticsHints.map((hint) => (
              <p key={hint} className="hmi-video__diagnostics-note">
                {hint}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
