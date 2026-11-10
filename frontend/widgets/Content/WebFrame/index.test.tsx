import '../../testSdk';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { __resetForTests } from '@hmi/utils/actionDispatcher';
import { useHmiStore } from '@hmi/store/hmiStore';
import { useVariableStore } from '@hmi/store/variableStore';
import WebFrame from './index';

vi.mock('@hmi/hooks/useWebSocket', () => ({
  sendWsMessage: vi.fn(),
}));

function renderFrame(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <WebFrame properties={properties} />
    </MemoryRouter>,
  );
}

describe('WebFrame', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTests();
    useHmiStore.setState({ pendingToasts: [] });
    useVariableStore.setState({ values: {}, varMeta: {} });
  });

  afterEach(() => {
    __resetForTests();
  });

  it('renders without throwing on empty properties', () => {
    renderFrame({});
    expect(screen.getByText('No URL configured')).toBeInTheDocument();
  });

  it('carries the base component class alongside its own', () => {
    const { container } = renderFrame({});
    const el = container.firstElementChild as HTMLElement;

    expect(el.classList.contains('hmi-component')).toBe(true);
    expect(el.classList.contains('hmi-webframe')).toBe(true);
  });

  it('sandboxes the iframe when enableSandbox is left unset', () => {
    const { container } = renderFrame({ url: 'https://example.com/' });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;

    // `sandbox=""` is the fully restrictive sandbox; dropping the attribute is
    // what would grant the frame full trust.
    expect(iframe.hasAttribute('sandbox')).toBe(true);
    expect(iframe.getAttribute('sandbox')).toBe('');
  });

  it('lists only the permitted sandbox tokens', () => {
    const { container } = renderFrame({
      url: 'https://example.com/',
      allowScripts: true,
      allowForms: true,
    });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;

    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
  });

  it('drops the sandbox attribute only when it is explicitly disabled', () => {
    const { container } = renderFrame({ url: 'https://example.com/', enableSandbox: false });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;

    expect(iframe.hasAttribute('sandbox')).toBe(false);
  });

  it('applies the border and radius classes and the background override', () => {
    const { container } = renderFrame({
      url: 'https://example.com/',
      borderStyle: 'subtle',
      cornerRadius: 'lg',
      backgroundColor: '#101820',
    });
    const el = container.firstElementChild as HTMLElement;

    expect(el.className).toMatch(/hmi-webframe--border-subtle/);
    expect(el.className).toMatch(/hmi-webframe--radius-lg/);
    expect(el.style.getPropertyValue('--hmi-webframe-bg')).toBe('#101820');
  });

  it('builds the allow attribute from the permission fields', () => {
    const { container } = renderFrame({
      url: 'https://example.com/',
      allowFullscreen: true,
      customAllow: 'speaker *',
    });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;

    expect(iframe.getAttribute('allow')).toBe('fullscreen *; speaker *');
  });

  it('writes an inbound message to the bound variable through the tracked write path', () => {
    const { container } = renderFrame({
      url: 'https://example.com/',
      allowedOrigins: 'https://example.com',
      inboundVariable: { $var: { path: 'PLC:Frame/Message' } },
    });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: 'from-the-page',
          origin: 'https://example.com',
          source: iframe.contentWindow,
        }),
      );
    });

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: 'write_field',
      requestId: expect.any(String),
      scope: 'runtime:preview',
      datasource: 'PLC',
      path: 'Frame/Message',
      value: 'from-the-page',
    });
  });

  it.each([
    ['*', 'https://evil.example'],
    ['https://example.com, *', 'https://evil.example'],
    // A sandbox without allow-same-origin gives every page in it this origin.
    ['null', 'null'],
  ])('never treats %s as a site that may send messages', (allowedOrigins, origin) => {
    const onMessage = [{ type: 'showToast', message: 'got it' }];
    const { container } = renderFrame({
      url: 'https://example.com/',
      allowedOrigins,
      inboundVariable: { $var: { path: 'PLC:Frame/Message' } },
      onMessage: { onMessage },
    });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: 'from-a-site-the-frame-navigated-to',
          origin,
          source: iframe.contentWindow,
        }),
      );
    });

    expect(sendWsMessage).not.toHaveBeenCalled();
    expect(useHmiStore.getState().pendingToasts).toEqual([]);
  });

  it('ignores a message from an origin that is not allowed', () => {
    const { container } = renderFrame({
      url: 'https://example.com/',
      allowedOrigins: 'https://example.com',
      inboundVariable: { $var: { path: 'PLC:Frame/Message' } },
    });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: 'from-elsewhere',
          origin: 'https://evil.example',
          source: iframe.contentWindow,
        }),
      );
    });

    expect(sendWsMessage).not.toHaveBeenCalled();
  });

  describe('outbound value', () => {
    /** Renders the frame, then sets the outbound variable, and returns what
     *  the frame's window was handed. */
    function sendOutbound(properties: Record<string, unknown>) {
      const { container } = renderFrame({
        ...properties,
        outboundVariable: { $var: { path: 'PLC:Frame/Out' } },
      });
      const iframe = container.querySelector('iframe') as HTMLIFrameElement;
      const postMessage = vi.spyOn(iframe.contentWindow as Window, 'postMessage');
      act(() => {
        useVariableStore.setState({ values: { 'PLC:Frame/Out': 'recipe-42' } });
      });
      return postMessage;
    }

    it.each([
      ['unset', undefined],
      ['*', '*'],
    ])('goes only to the origin of the URL when the target is %s', (_label, outboundOrigin) => {
      const postMessage = sendOutbound({
        url: 'https://portal.example.com/orders?line=3',
        outboundOrigin,
      });
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenCalledWith('recipe-42', 'https://portal.example.com');
    });

    it('goes to a target origin the project names', () => {
      const postMessage = sendOutbound({
        url: 'https://portal.example.com/',
        outboundOrigin: 'https://other.example',
      });
      expect(postMessage).toHaveBeenCalledWith('recipe-42', 'https://other.example');
    });

    it.each(['about:blank', '/local/page.html', 'data:text/html,<p>hi</p>'])(
      'is not sent when the URL has no origin of its own (%s)',
      (url) => {
        const postMessage = sendOutbound({ url });
        expect(postMessage).not.toHaveBeenCalled();
      },
    );
  });
});
