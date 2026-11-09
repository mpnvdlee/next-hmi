// The editor half of the manifest carries the field's placeholder, as it does
// under ConfigRoutes.
import '@hmi/registry/builtinWidgetsEditorMetadata';
import { fireEvent, render, screen } from '@testing-library/react';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useConfigStore } from '@shared/store/configStore';
import { useProjectStore } from '@shared/store/projectStore';
import { useTranslationStore } from '@shared/store/translationStore';
import type { WidgetConfig } from '@shared/types/config';
import PropertiesPanel from './index';

function frameProperties(): Record<string, unknown> {
  const page = useConfigStore.getState().pages[0];
  const widgets: WidgetConfig[] = page.type === 'page' ? (page.sections.main ?? []) : [];
  return widgets[0]?.properties ?? {};
}

function renderFrame(properties: Record<string, unknown>) {
  useProjectStore.setState({
    dirty: false,
    saving: false,
    saveError: null,
    past: [],
    future: [],
    _saveCallbacks: new Map(),
  });
  useTranslationStore.setState({
    languages: [{ code: 'en' }],
    translations: {},
    loaded: true,
    activeLanguage: 'en',
    dictionaries: ['Default'],
    activeDictionary: 'Default',
    _draftsByDictionary: {},
  });
  useConfigStore.setState({
    pages: [
      {
        id: 'page-1',
        type: 'page',
        title: 'Page 1',
        sections: {
          main: [{ id: 'frame', type: 'WebFrame', name: 'Supplier portal', properties }],
        },
      },
    ],
    header: [],
    footer: [],
    dialogs: [],
    loaded: true,
    loadedPageIds: new Set(['page-1']),
    dirtyPageIds: new Set(),
  });
  useEditorDomainStore.setState({ selectedId: 'frame', selectedIds: [] });
  return render(<PropertiesPanel />);
}

const SANDBOX_WARNING = /and the sandbox is off\. Whoever can change/;
const ANY_INBOUND = /“\*” is not allowed: every message runs On Message and writes to a variable/;

describe('Web Frame notices in the properties panel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('warns about a bound URL with the sandbox off, and turns the sandbox back on', () => {
    renderFrame({ url: { $var: { path: 'PLC:Line3/PortalUrl' } }, enableSandbox: false });

    const warning = screen.getByText(SANDBOX_WARNING).closest('[role="status"]') as HTMLElement;
    expect(warning).toHaveTextContent(
      'The URL comes from a variable and the sandbox is off. Whoever can change PLC: Line3/PortalUrl decides which site this panel shows, with full access to its messages.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Turn on sandbox' }));
    expect(frameProperties().enableSandbox).toBe(true);
    expect(screen.queryByText(SANDBOX_WARNING)).toBeNull();
  });

  it('warns about a URL from any other source with the sandbox off', () => {
    renderFrame({ url: { $urlParam: { name: 'portal', default: '' } }, enableSandbox: false });
    expect(screen.getByText(SANDBOX_WARNING).closest('[role="status"]')).toHaveTextContent(
      'The URL is not fixed and the sandbox is off. Whoever can change ?portal decides',
    );
  });

  it.each([
    ['a fixed URL', { url: 'https://portal.example.com/', enableSandbox: false }],
    ['a sandboxed bound URL', { url: { $var: { path: 'PLC:Line3/PortalUrl' } } }],
  ])('says nothing about %s', (_label, properties) => {
    renderFrame(properties);
    expect(screen.queryByText(SANDBOX_WARNING)).toBeNull();
  });

  it('shows the origin the outbound value goes to by default', () => {
    renderFrame({ url: 'https://portal.example.com/orders?line=3' });
    expect(screen.getByPlaceholderText('Same as the URL (default)')).toBeInTheDocument();
    expect(screen.getByText(/The outbound value goes to no other site/)).toHaveTextContent(
      'Now https://portal.example.com. The outbound value goes to no other site.',
    );
  });

  it('says a URL without an origin gets no outbound value', () => {
    renderFrame({ url: 'about:blank' });
    expect(
      screen.getByText('The URL has no origin of its own, so the outbound value is not sent.'),
    ).toBeInTheDocument();
  });

  it('warns that an outbound * goes to the URL origin instead', () => {
    renderFrame({ url: 'https://portal.example.com/', outboundOrigin: '*' });
    expect(screen.getByText(/“\*” would send the value to whatever site/)).toBeInTheDocument();
    expect(screen.getByText(/Now/)).toHaveTextContent('Now https://portal.example.com.');
  });

  it('says nothing under an outbound origin that names a site', () => {
    renderFrame({ url: 'https://portal.example.com/', outboundOrigin: 'https://other.example' });
    expect(screen.queryByText(/The outbound value goes to no other site/)).toBeNull();
  });

  it('refuses * among the allowed inbound origins and names the URL origin', () => {
    renderFrame({ url: 'https://portal.example.com/', allowedOrigins: 'https://a.example, *' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      '“*” is not allowed: every message runs On Message and writes to a variable. List the sites that may send messages, such as https://portal.example.com.',
    );
  });

  it('refuses null, the origin every page in a plain sandbox shares', () => {
    renderFrame({ url: { $var: { path: 'PLC:Line3/PortalUrl' } }, allowedOrigins: 'null' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      '“null” is not allowed: every message runs On Message and writes to a variable. List the sites that may send messages.',
    );
  });

  it('says nothing about a list of real inbound origins', () => {
    renderFrame({
      url: 'https://portal.example.com/',
      allowedOrigins: 'https://portal.example.com',
    });
    expect(screen.queryByText(ANY_INBOUND)).toBeNull();
  });
});
