/* @jsxRuntime classic */
export const schema = {
  url: { type: 'string' as const, label: 'URL', group: 'Content' },
  title: { type: 'string' as const, label: 'Title', group: 'Content' },

  showHeader: {
    type: 'boolean' as const,
    label: 'Show header bar',
    group: 'Appearance',
    defaultValue: false,
  },
  showReloadButton: {
    type: 'boolean' as const,
    label: 'Show reload button',
    group: 'Appearance',
    defaultValue: true,
    visibleWhen: { property: 'showHeader', equals: true },
  },
  showOpenInNewTab: {
    type: 'boolean' as const,
    label: 'Show open-in-new-tab button',
    group: 'Appearance',
    defaultValue: true,
    visibleWhen: { property: 'showHeader', equals: true },
  },
  showLoadingState: {
    type: 'boolean' as const,
    label: 'Show loading overlay',
    group: 'Appearance',
    defaultValue: true,
  },
  showErrorFallback: {
    type: 'boolean' as const,
    label: 'Show error fallback',
    group: 'Appearance',
    defaultValue: true,
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
  backgroundColor: {
    type: 'color' as const,
    label: 'Background color',
    group: 'Appearance',
    defaultToken: '--hmi-bg',
  },

  loading: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Loading',
    group: 'Behaviour',
    defaultValue: 'eager',
    options: [
      { label: 'Eager', value: 'eager' },
      { label: 'Lazy', value: 'lazy' },
    ],
  },
  referrerPolicy: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Referrer policy',
    group: 'Behaviour',
    defaultValue: 'strict-origin-when-cross-origin',
    options: [
      { label: 'No referrer', value: 'no-referrer' },
      { label: 'No referrer when downgrade', value: 'no-referrer-when-downgrade' },
      { label: 'Origin', value: 'origin' },
      { label: 'Origin when cross-origin', value: 'origin-when-cross-origin' },
      { label: 'Same origin', value: 'same-origin' },
      { label: 'Strict origin', value: 'strict-origin' },
      { label: 'Strict origin when cross-origin', value: 'strict-origin-when-cross-origin' },
      { label: 'Unsafe URL', value: 'unsafe-url' },
    ],
  },
  scrolling: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Scrolling',
    group: 'Behaviour',
    defaultValue: 'auto',
    options: [
      { label: 'Auto', value: 'auto' },
      { label: 'Yes', value: 'yes' },
      { label: 'No', value: 'no' },
    ],
  },
  reloadInterval: {
    type: 'integer' as const,
    label: 'Reload interval (seconds)',
    group: 'Behaviour',
    min: 0,
    step: 1,
    defaultValue: 0,
    description: 'Zero disables the timer.',
  },
  reloadTrigger: {
    type: 'string' as const,
    label: 'Reload trigger variable',
    group: 'Behaviour',
    description: 'Reloads the page whenever this value changes.',
  },

  enableSandbox: {
    type: 'boolean' as const,
    label: 'Enable sandbox',
    group: 'Sandbox',
    defaultValue: true,
  },
  allowScripts: {
    type: 'boolean' as const,
    label: 'Allow scripts',
    group: 'Sandbox',
    defaultValue: false,
    visibleWhen: { property: 'enableSandbox', notEquals: false },
  },
  allowSameOrigin: {
    type: 'boolean' as const,
    label: 'Allow same-origin',
    group: 'Sandbox',
    defaultValue: false,
    visibleWhen: { property: 'enableSandbox', notEquals: false },
  },
  allowForms: {
    type: 'boolean' as const,
    label: 'Allow forms',
    group: 'Sandbox',
    defaultValue: false,
    visibleWhen: { property: 'enableSandbox', notEquals: false },
  },
  allowPopups: {
    type: 'boolean' as const,
    label: 'Allow popups',
    group: 'Sandbox',
    defaultValue: false,
    visibleWhen: { property: 'enableSandbox', notEquals: false },
  },
  allowPopupsToEscapeSandbox: {
    type: 'boolean' as const,
    label: 'Allow popups to escape sandbox',
    group: 'Sandbox',
    defaultValue: false,
    visibleWhen: { property: 'enableSandbox', notEquals: false },
  },
  allowModals: {
    type: 'boolean' as const,
    label: 'Allow modals',
    group: 'Sandbox',
    defaultValue: false,
    visibleWhen: { property: 'enableSandbox', notEquals: false },
  },
  allowDownloads: {
    type: 'boolean' as const,
    label: 'Allow downloads',
    group: 'Sandbox',
    defaultValue: false,
    visibleWhen: { property: 'enableSandbox', notEquals: false },
  },
  allowTopNavigation: {
    type: 'boolean' as const,
    label: 'Allow top navigation',
    group: 'Sandbox',
    defaultValue: false,
    visibleWhen: { property: 'enableSandbox', notEquals: false },
  },
  allowPointerLock: {
    type: 'boolean' as const,
    label: 'Allow pointer lock',
    group: 'Sandbox',
    defaultValue: false,
    visibleWhen: { property: 'enableSandbox', notEquals: false },
  },
  allowOrientationLock: {
    type: 'boolean' as const,
    label: 'Allow orientation lock',
    group: 'Sandbox',
    defaultValue: false,
    visibleWhen: { property: 'enableSandbox', notEquals: false },
  },
  allowPresentation: {
    type: 'boolean' as const,
    label: 'Allow presentation',
    group: 'Sandbox',
    defaultValue: false,
    visibleWhen: { property: 'enableSandbox', notEquals: false },
  },

  allowFullscreen: {
    type: 'boolean' as const,
    label: 'Allow fullscreen',
    group: 'Permissions',
    defaultValue: false,
  },
  allowCamera: {
    type: 'boolean' as const,
    label: 'Allow camera',
    group: 'Permissions',
    defaultValue: false,
  },
  allowMicrophone: {
    type: 'boolean' as const,
    label: 'Allow microphone',
    group: 'Permissions',
    defaultValue: false,
  },
  allowGeolocation: {
    type: 'boolean' as const,
    label: 'Allow geolocation',
    group: 'Permissions',
    defaultValue: false,
  },
  allowAutoplay: {
    type: 'boolean' as const,
    label: 'Allow autoplay',
    group: 'Permissions',
    defaultValue: false,
  },
  allowClipboardRead: {
    type: 'boolean' as const,
    label: 'Allow clipboard read',
    group: 'Permissions',
    defaultValue: false,
  },
  allowClipboardWrite: {
    type: 'boolean' as const,
    label: 'Allow clipboard write',
    group: 'Permissions',
    defaultValue: false,
  },
  allowPayment: {
    type: 'boolean' as const,
    label: 'Allow payment',
    group: 'Permissions',
    defaultValue: false,
  },
  customAllow: {
    type: 'string' as const,
    label: 'Custom allow',
    group: 'Permissions',
    placeholder: 'e.g. speaker *; display-capture *',
  },

  allowedOrigins: {
    type: 'string' as const,
    label: 'Allowed inbound origins',
    group: 'Data',
    description:
      'Comma-separated origins, or * for any. Left empty, every inbound message is ignored.',
  },
  inboundVariable: {
    type: 'string' as const,
    label: 'Inbound variable (write target)',
    group: 'Data',
    write: true,
  },
  outboundVariable: { type: 'string' as const, label: 'Outbound variable', group: 'Data' },
  outboundOrigin: {
    type: 'string' as const,
    label: 'Outbound target origin',
    group: 'Data',
    defaultValue: '*',
  },

  onLoad: { type: 'actions' as const, label: 'On Load', group: 'Actions', event: 'onLoad' },
  onError: { type: 'actions' as const, label: 'On Error', group: 'Actions', event: 'onError' },
  onMessage: {
    type: 'actions' as const,
    label: 'On Message',
    group: 'Actions',
    event: 'onMessage',
  },
};

export const displayName = 'Web Frame';
export const description = 'Embeds an external web page in an iframe.';
export const category = 'Content & controls';
export const icon = { type: 'builtin', name: 'browsers' } as const;

export default function WebFrame({ properties, layout }: HmiWidgetProps) {
  const scope = useHmiScope();
  const evalCtx = useEvalContext();

  const url = usePropString(properties, 'url', '');
  const title = usePropString(properties, 'title', '');

  const showHeader = usePropBoolean(properties, 'showHeader', false);
  const showReloadButton = usePropBoolean(properties, 'showReloadButton', true);
  const showOpenInNewTab = usePropBoolean(properties, 'showOpenInNewTab', true);
  const showLoadingState = usePropBoolean(properties, 'showLoadingState', true);
  const showErrorFallback = usePropBoolean(properties, 'showErrorFallback', true);
  const borderStyle = usePropString(properties, 'borderStyle', 'none');
  const cornerRadius = usePropString(properties, 'cornerRadius', 'none');
  const backgroundColor = usePropString(properties, 'backgroundColor', '');

  const loading = usePropString(properties, 'loading', 'eager');
  const referrerPolicy = usePropString(
    properties,
    'referrerPolicy',
    'strict-origin-when-cross-origin',
  );
  const scrolling = usePropString(properties, 'scrolling', 'auto');

  const enableSandbox = usePropBoolean(properties, 'enableSandbox', true);
  const allowScripts = usePropBoolean(properties, 'allowScripts', false);
  const allowSameOrigin = usePropBoolean(properties, 'allowSameOrigin', false);
  const allowForms = usePropBoolean(properties, 'allowForms', false);
  const allowPopups = usePropBoolean(properties, 'allowPopups', false);
  const allowPopupsToEscapeSandbox = usePropBoolean(
    properties,
    'allowPopupsToEscapeSandbox',
    false,
  );
  const allowModals = usePropBoolean(properties, 'allowModals', false);
  const allowDownloads = usePropBoolean(properties, 'allowDownloads', false);
  const allowTopNavigation = usePropBoolean(properties, 'allowTopNavigation', false);
  const allowPointerLock = usePropBoolean(properties, 'allowPointerLock', false);
  const allowOrientationLock = usePropBoolean(properties, 'allowOrientationLock', false);
  const allowPresentation = usePropBoolean(properties, 'allowPresentation', false);

  const allowFullscreen = usePropBoolean(properties, 'allowFullscreen', false);
  const allowCamera = usePropBoolean(properties, 'allowCamera', false);
  const allowMicrophone = usePropBoolean(properties, 'allowMicrophone', false);
  const allowGeolocation = usePropBoolean(properties, 'allowGeolocation', false);
  const allowAutoplay = usePropBoolean(properties, 'allowAutoplay', false);
  const allowClipboardRead = usePropBoolean(properties, 'allowClipboardRead', false);
  const allowClipboardWrite = usePropBoolean(properties, 'allowClipboardWrite', false);
  const allowPayment = usePropBoolean(properties, 'allowPayment', false);
  const customAllow = usePropString(properties, 'customAllow', '');

  const reloadInterval = usePropNumber(properties, 'reloadInterval', 0);
  const reloadTrigger = usePropVar(properties, 'reloadTrigger');

  const allowedOrigins = usePropString(properties, 'allowedOrigins', '');
  const outboundValue = usePropVar(properties, 'outboundVariable');
  const outboundOrigin = usePropString(properties, 'outboundOrigin', '*');
  const writeInbound = useWriteVariable(properties, 'inboundVariable');

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    if (!reloadInterval || reloadInterval <= 0) return;
    const t = setInterval(() => setReloadKey((k) => k + 1), reloadInterval * 1000);
    return () => clearInterval(t);
  }, [reloadInterval]);

  const lastTrigger = useRef<unknown>(reloadTrigger);
  useEffect(() => {
    if (lastTrigger.current !== reloadTrigger) {
      lastTrigger.current = reloadTrigger;
      setReloadKey((k) => k + 1);
    }
  }, [reloadTrigger]);

  useEffect(() => {
    if (!allowedOrigins) return;
    const allow = allowedOrigins
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean);
    const handler = (ev: MessageEvent) => {
      if (ev.source !== iframeRef.current?.contentWindow) return;
      if (!allow.includes('*') && !allow.includes(ev.origin)) return;

      const actions = properties?.onMessage as ActionsConfig | undefined;
      executeWidgetActions(actions?.onMessage, { scope, evalCtx });

      writeInbound(typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data));
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [allowedOrigins, properties, scope, evalCtx, writeInbound]);

  const lastOutbound = useRef<unknown>(undefined);
  useEffect(() => {
    if (outboundValue === undefined) return;
    if (lastOutbound.current === outboundValue) return;
    lastOutbound.current = outboundValue;
    iframeRef.current?.contentWindow?.postMessage(outboundValue, outboundOrigin || '*');
  }, [outboundValue, outboundOrigin]);

  useEffect(() => {
    setLoaded(false);
    setErrored(false);
  }, [url, reloadKey]);

  // `sandbox=""` is a real, fully restrictive sandbox; no attribute at all is
  // the unrestricted case. So sandboxing off must return undefined, and
  // sandboxing on with nothing allowed must return the empty string.
  const sandboxAttr = useMemo<string | undefined>(() => {
    if (!enableSandbox) return undefined;
    const tokens: string[] = [];
    if (allowScripts) tokens.push('allow-scripts');
    if (allowSameOrigin) tokens.push('allow-same-origin');
    if (allowForms) tokens.push('allow-forms');
    if (allowPopups) tokens.push('allow-popups');
    if (allowPopupsToEscapeSandbox) tokens.push('allow-popups-to-escape-sandbox');
    if (allowModals) tokens.push('allow-modals');
    if (allowDownloads) tokens.push('allow-downloads');
    if (allowTopNavigation) tokens.push('allow-top-navigation');
    if (allowPointerLock) tokens.push('allow-pointer-lock');
    if (allowOrientationLock) tokens.push('allow-orientation-lock');
    if (allowPresentation) tokens.push('allow-presentation');
    return tokens.join(' ');
  }, [
    enableSandbox,
    allowScripts,
    allowSameOrigin,
    allowForms,
    allowPopups,
    allowPopupsToEscapeSandbox,
    allowModals,
    allowDownloads,
    allowTopNavigation,
    allowPointerLock,
    allowOrientationLock,
    allowPresentation,
  ]);

  const allowAttr = useMemo<string | undefined>(() => {
    const parts: string[] = [];
    if (allowFullscreen) parts.push('fullscreen *');
    if (allowCamera) parts.push('camera *');
    if (allowMicrophone) parts.push('microphone *');
    if (allowGeolocation) parts.push('geolocation *');
    if (allowAutoplay) parts.push('autoplay *');
    if (allowClipboardRead) parts.push('clipboard-read *');
    if (allowClipboardWrite) parts.push('clipboard-write *');
    if (allowPayment) parts.push('payment *');
    if (customAllow) parts.push(customAllow);
    return parts.length > 0 ? parts.join('; ') : undefined;
  }, [
    allowFullscreen,
    allowCamera,
    allowMicrophone,
    allowGeolocation,
    allowAutoplay,
    allowClipboardRead,
    allowClipboardWrite,
    allowPayment,
    customAllow,
  ]);

  function handleLoad() {
    setLoaded(true);
    setErrored(false);
    const actions = properties?.onLoad as ActionsConfig | undefined;
    executeWidgetActions(actions?.onLoad, { scope, evalCtx });
  }

  function handleError() {
    setErrored(true);
    const actions = properties?.onError as ActionsConfig | undefined;
    executeWidgetActions(actions?.onError, { scope, evalCtx });
  }

  function handleReload() {
    setReloadKey((k) => k + 1);
  }

  const rootClasses = [
    'hmi-component',
    'hmi-webframe',
    borderStyle !== 'none' ? `hmi-webframe--border-${borderStyle}` : '',
    cornerRadius !== 'none' ? `hmi-webframe--radius-${cornerRadius}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const containerStyle: Record<string, string> = {};
  if (backgroundColor) containerStyle['--hmi-webframe-bg'] = backgroundColor;

  return (
    <div className={rootClasses} style={{ ...selfLayoutStyle(layout), ...containerStyle }}>
      {showHeader && (
        <div className="hmi-webframe__header">
          <span className="hmi-webframe__title">{title || url}</span>
          <div className="hmi-webframe__actions">
            {showReloadButton && (
              <button
                className="hmi-webframe__btn"
                type="button"
                title="Reload"
                onClick={handleReload}
              >
                &#8635;
              </button>
            )}
            {showOpenInNewTab && url && (
              <a
                className="hmi-webframe__btn"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                title="Open in new tab"
              >
                &#8599;
              </a>
            )}
          </div>
        </div>
      )}

      <div className="hmi-webframe__body">
        {!url && <div className="hmi-webframe__placeholder">No URL configured</div>}

        {url && showErrorFallback && errored && (
          <div className="hmi-webframe__error">
            <span>Unable to load page.</span>
            <a href={url} target="_blank" rel="noopener noreferrer">
              Open in new tab
            </a>
          </div>
        )}

        {url && showLoadingState && !loaded && !errored && (
          <div className="hmi-webframe__loading">Loading&hellip;</div>
        )}

        {url && (
          <iframe
            key={`${url}-${reloadKey}`}
            ref={iframeRef}
            className="hmi-webframe__iframe"
            src={url}
            title={title || undefined}
            loading={loading as 'eager' | 'lazy'}
            referrerPolicy={referrerPolicy as ReferrerPolicy}
            scrolling={scrolling}
            sandbox={sandboxAttr}
            allow={allowAttr}
            onLoad={handleLoad}
            onError={handleError}
          />
        )}
      </div>
    </div>
  );
}
