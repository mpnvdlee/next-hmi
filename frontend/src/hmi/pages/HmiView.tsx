import '../styles/hmi.css';
import '../styles/hmi-view.css';
import { useDeferredValue, useEffect, useLayoutEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useConfig, usePage, usePages } from '@shared/hooks/useConfig';
import { useTranslations } from '@shared/hooks/useTranslations';
import { useDisableBrowserZoom } from '@shared/hooks/useDisableBrowserZoom';
import { useConfigStore } from '@shared/store/configStore';
import { useComponentStore } from '@shared/store/componentStore';
import { useHmiStore } from '../store/hmiStore';
import {
  sendWsMessage,
  setBackendRestartHandler,
  setContextProducer,
  clearContextProducer,
  holdValueFrames,
  releaseValueFrames,
} from '../hooks/useWebSocket';
import { useVariableStore } from '../store/variableStore';
import { resolveMainStyle, resolvePageContext } from '@shared/utils/pageTree';
import { getPageChildren } from '@shared/utils/pageContent';
import { randomUuid } from '@shared/utils/id';
import { routerBasename } from '@shared/utils/runtimeBase';
import { HmiScopeContext } from '../context/HmiScopeContext';
import { resolvePageOverlays, useResolvedPageOverlays } from '../hooks/useOpenOverlays';
import { announcePage, setPageAnnouncer } from '../utils/pageAnnouncer';
import { renderRegionChildren } from '../components/renderRegion';
import ShellRegion from '../components/ShellRegion';
import { useSidebarFullHeight } from '../components/ShellRegion/useSidebarFullHeight';
import { useFloatingBars } from '../components/ShellRegion/useFloatingBars';
import PageGroupPageView from '../components/PageGroupPageView';
import type { ShellConfig, ShellRegionConfig } from '@shared/types/config';
import type { CSSWithVars } from '@shared/types/style';
import { ModalStack } from '../components/ModalStack';
import { AlertModal } from '../components/AlertModal';
import { EditValueNumpad } from '../components/EditValueNumpad';
import { ActionNavigation } from '../components/ActionNavigation';
import { HmiToastStack } from '../components/ToastStack';
import AlarmPopup from '../components/AlarmPopup';
import { FullscreenPrompt } from '../components/FullscreenPrompt';
import BootSplash from '../components/BootSplash';
import { PageDataSettleGate } from '../components/DataSettleGate';
import { markBooted, useBootHold } from '../components/BootSplash/bootHold';
import { collectComponentPriorityKeys } from '../components/layoutUtils';
import { extractVarKeys } from '../utils/extractVarKeys';
import { ContentSpinner } from '@shared/components/Spinner';
import { useGlobalEvents } from '../hooks/useGlobalEvents';
import { usePageEvents } from '../hooks/usePageEvents';
import { useProjectWidgetWarmup } from '../hooks/useProjectWidgetWarmup';
import ConnectionLostOverlay from '@shared/components/ConnectionLostOverlay';
import { identityRequest } from '../utils/runtimeSession';

const reloadPage = () => window.location.reload();

/** The longest a navigation holds its page's value frames back: past it, a
 *  page still building takes them as before, and a navigation that never
 *  commits (to the page already shown) stops holding. */
const PAGE_BUILD_HOLD_MS = 300;

/**
 * The runtime's `set_context` for page `id` (a group resolves to its active
 * page) and the open overlays, read from the stores as they are now. The
 * backend computes the full variable set itself, so nested expressions (for
 * example $if/$switch/$compare) are included; the priority keys, collected
 * from the in-memory component tree, let it subscribe variables even before
 * the config is saved to disk. HmiView's effect and a navigation's announce
 * both send it, so the second finds an identical context and sends nothing.
 */
function runtimePageContext(id: string | undefined): {
  currentPageIds: string[];
  priorityKeys: string[];
} {
  const { pages, dialogs, header, footer, leftSidebar, rightSidebar, globalEvents } =
    useConfigStore.getState();
  const { page } = resolvePageContext(pages, id);
  const overlays = resolvePageOverlays(useHmiStore.getState().openPageOverlays, pages, dialogs);
  const overlayIds = overlays.flatMap((item) => (item.page ? [item.page.id] : []));
  const components = [
    ...(page ? getPageChildren(page) : []),
    ...header,
    ...footer,
    ...leftSidebar,
    ...rightSidebar,
    ...overlays.flatMap((item) => (item.page ? getPageChildren(item.page) : [])),
  ];
  // onHmiLoaded's variables too: useGlobalEvents holds that event back until
  // this context's values have arrived, so its `if` reads them, not "no value".
  // A variable trigger watches its variable on every page.
  return {
    currentPageIds: page?.id ? [page.id, ...overlayIds] : overlayIds,
    priorityKeys: [
      ...collectComponentPriorityKeys(components),
      ...extractVarKeys(globalEvents.onHmiLoaded),
      ...extractVarKeys(globalEvents.onVariableChanged),
    ],
  };
}

export default function HmiView() {
  useConfig();
  useTranslations();
  useDisableBrowserZoom();

  // Theme loading and cross-tab theme-save sync are owned by AppInner, which
  // starts them before any view mounts.

  // Generate a stable unique scope key for this HMI view instance.
  // Created once on first mount; remounted instances get a new key.
  const hmiKeyRef = useRef<string | null>(null);
  if (hmiKeyRef.current === null) {
    hmiKeyRef.current = randomUuid().replace(/-/g, '').slice(0, 12);
  }
  const scope = `runtime:${hmiKeyRef.current}`;

  useGlobalEvents(scope);

  const { id } = useParams<{ id: string }>();
  // Render the (potentially heavy) page from a deferred id so switching pages
  // stays interruptible: the URL/menu update urgently while the page render and
  // the outgoing page's teardown run at low priority. `pageSwitching` is true
  // during that window so we can cover the swap with a spinner overlay.
  const deferredId = useDeferredValue(id);
  // After useGlobalEvents deliberately: effects run in declaration order, so
  // the project-wide onPageLoaded fires before the page's own onOpen. On the
  // rendered id, so the page's inputs are in place when its events read them.
  usePageEvents(scope, deferredId);
  const pageSwitching = id !== deferredId;
  const navigate = useNavigate();
  const pages = useConfigStore((s) => s.pages);
  const header = useConfigStore((s) => s.header);
  const footer = useConfigStore((s) => s.footer);
  const leftSidebar = useConfigStore((s) => s.leftSidebar);
  const rightSidebar = useConfigStore((s) => s.rightSidebar);
  const shell = useConfigStore((s) => s.shell);
  const configLoaded = useConfigStore((s) => s.loaded);
  const wsConnected = useVariableStore((s) => s.wsConnected);
  const openPageOverlayEntries = useHmiStore((s) => s.openPageOverlays);

  // Boot screen minimum. Paid once per page load — every open and refresh of
  // the HMI shows the screen; route changes within that load do not.
  const bootHold = useBootHold();
  useEffect(() => {
    if (configLoaded && !bootHold) markBooted();
  }, [configLoaded, bootHold]);

  // Resolve the current page from the index first, then hydrate its content.
  const { page, pageGroups } = resolvePageContext(pages, id);
  usePage(page?.id);
  useProjectWidgetWarmup(configLoaded && !bootHold ? page?.id : undefined);
  const openPageOverlays = useResolvedPageOverlays();
  // The *resolved* page of each overlay, never the raw target: an overlay may
  // name a page group, which has no page file to hydrate and no id the backend
  // would echo back — the page inside it is what both of those need.
  const openPageOverlayIds = openPageOverlays.flatMap((item) => (item.page ? [item.page.id] : []));
  // Hydrate content for every open overlay page so their component children are available.
  usePages(openPageOverlayIds);

  // Request this scope's identity when WS connects (or reconnects): the tab's
  // login when it can still be resumed, the auto-login user otherwise.
  useEffect(() => {
    if (!wsConnected) return;
    sendWsMessage(identityRequest(scope));
  }, [wsConnected, scope]);
  // A restarted backend may serve newer config: load it fresh. A reconnect to
  // the same backend needs nothing, and the tab's login survives either way.
  useEffect(() => {
    setBackendRestartHandler(reloadPage);
    return () => setBackendRestartHandler(null);
  }, []);

  // Send active runtime context (see `runtimePageContext`). Component
  // definitions load asynchronously; the priority keys a `$component:`
  // instance derives from its definition only exist once it has.
  const componentDefinitions = useComponentStore((s) => s.components);
  useEffect(() => {
    if (!wsConnected) return;
    setContextProducer('page', runtimePageContext(id));
    // page, header, footer, openPageOverlays are intentionally
    // omitted from deps: page?.id already re-triggers on navigation, and we
    // do NOT want to re-send set_context on every component edit in the
    // config editor while the HMI view is active.
    // openPageOverlayEntries (Zustand state) changes reference only when overlays
    // are actually added/removed, avoiding spurious re-fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsConnected, page?.id, openPageOverlayEntries, componentDefinitions]);

  // A navigation sends the page's context before React builds the page
  // (`pageAnnouncer`), so the values the server holds arrive while it builds;
  // the effect above then finds the same context already sent. Their frames
  // wait until the page has committed and land before the browser paints, so
  // the build is not thrown away for them and the page draws with its values.
  // Browser back and forward navigate without a call site, so they announce
  // from here.
  useEffect(() => {
    setPageAnnouncer((pageId) => {
      if (!useVariableStore.getState().wsConnected) return;
      holdValueFrames(PAGE_BUILD_HOLD_MS);
      setContextProducer('page', runtimePageContext(pageId));
    });
    const onPopState = () => {
      const path = window.location.pathname.slice(routerBasename().length);
      const match = /^\/pages\/([^/]+)/.exec(path);
      if (match) announcePage(decodeURIComponent(match[1]));
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      setPageAnnouncer(null);
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  useLayoutEffect(() => releaseValueFrames(), [id]);

  // Clear this client's runtime context only on true unmount (navigating away
  // from the HMI view entirely). Deliberately a separate, empty-deps effect:
  // folding this into the effect above would fire its cleanup — and so this
  // "clear" send — before every re-run, doubling the set_context traffic (and
  // the backend's OPC-UA priority-subscription recompute) on every ordinary
  // page navigation or overlay toggle.
  useEffect(() => {
    return () => {
      clearContextProducer('page');
    };
  }, []);

  const resolvedShell: ShellConfig = shell ?? {};
  const mainStyle: CSSWithVars = resolveMainStyle(pageGroups, page);
  // `--hmi-scale` drives `.hmi-root`'s `zoom` (hmi.css) — CSS `zoom`
  // participates in box sizing AND propagates to position:fixed descendants
  // (toasts, alerts, alarm popups) so they scale together with the shell
  // regions. The same custom property also lets .hmi-root invert the
  // viewport sizes so the zoomed layout still fills the viewport.
  const rootStyle: CSSWithVars =
    resolvedShell.hmiScale && resolvedShell.hmiScale !== 1
      ? { '--hmi-scale': resolvedShell.hmiScale }
      : {};
  const rootClassName = `hmi-root${resolvedShell.showScrollbars ? ' hmi-root--scrollbars' : ''}`;

  const headerCfg: ShellRegionConfig = resolvedShell.header ?? {};
  const footerCfg: ShellRegionConfig = resolvedShell.footer ?? {};
  const leftSidebarCfg: ShellRegionConfig = resolvedShell.leftSidebar ?? {};
  const rightSidebarCfg: ShellRegionConfig = resolvedShell.rightSidebar ?? {};

  const headerContent = renderRegionChildren(header);
  const footerContent = renderRegionChildren(footer);
  const leftSidebarContent = renderRegionChildren(leftSidebar);
  const rightSidebarContent = renderRegionChildren(rightSidebar);

  const {
    left: leftFullHeight,
    right: rightFullHeight,
    any: hasFullHeightSidebar,
  } = useSidebarFullHeight(leftSidebarCfg, rightSidebarCfg);
  const floatingBars = useFloatingBars(headerCfg, footerCfg);

  // Built once and placed at whichever of the two mutually-exclusive slots
  // below is active (full-height spans the whole column; otherwise it sits
  // inside .hmi-body next to main) — only one slot ever renders at a time.
  const leftSidebarRegion = (
    <ShellRegion id="leftSidebar" config={leftSidebarCfg}>
      {leftSidebarContent}
    </ShellRegion>
  );
  const rightSidebarRegion = (
    <ShellRegion id="rightSidebar" config={rightSidebarCfg}>
      {rightSidebarContent}
    </ShellRegion>
  );

  // A floating header/footer moves into `.hmi-main` (see useFloatingBars).
  const headerRegion = (
    <ShellRegion id="header" config={headerCfg}>
      {headerContent}
    </ShellRegion>
  );
  const footerRegion = (
    <ShellRegion id="footer" config={footerCfg}>
      {footerContent}
    </ShellRegion>
  );

  const pageView = (
    <PageGroupPageView
      pages={pages}
      requestedId={deferredId}
      onNavigate={(pageId, replace) => {
        // Navigate urgently so the URL/menu react immediately; the deferred
        // requestedId keeps the actual page render/teardown at low priority.
        announcePage(pageId);
        navigate(`/pages/${pageId}`, { replace: replace ?? false });
      }}
      readsArrivals
    />
  );

  // Main boot screen: hold it (seamless with ComponentsReadyGate) until the
  // config index lands, so the shell renders in one go instead of flashing an
  // empty "No page found" frame. Once the shell is up, the first page's content
  // shows its own spinner while it hydrates. `bootHold` keeps the screen on for
  // its minimum duration past that, so the attribution notice is actually seen.
  if (!configLoaded || bootHold) {
    return <BootSplash phase={configLoaded ? 'ready' : 'config'} />;
  }

  // One gate over the whole runtime: the shell regions, the page, and the
  // overlays portalled out of it all read their variables from the same
  // `set_context`, so they settle together on its ack. Nothing under here
  // wears a "no data" mark until that lands (or the grace expires) — the page
  // itself is on screen long before, unblocked by the datasource.
  return (
    <HmiScopeContext.Provider value={scope}>
      <PageDataSettleGate pageId={page?.id}>
        <div className={rootClassName} style={rootStyle}>
          <div className={`hmi-layout${hasFullHeightSidebar ? ' hmi-layout--row' : ''}`}>
            {leftFullHeight && leftSidebarRegion}
            <div className="hmi-layout__column">
              {!floatingBars.header && headerRegion}
              <div className="hmi-body">
                {!leftFullHeight && leftSidebarRegion}
                <main className="hmi-main" style={mainStyle}>
                  {pageView}
                  {pageSwitching && (
                    <div className="hmi-page-pending" aria-hidden>
                      <ContentSpinner />
                    </div>
                  )}
                  {floatingBars.header && headerRegion}
                  {floatingBars.footer && footerRegion}
                </main>
                {!rightFullHeight && rightSidebarRegion}
              </div>
              {!floatingBars.footer && footerRegion}
            </div>
            {rightFullHeight && rightSidebarRegion}
            <ModalStack />
          </div>
          <AlertModal scope={scope} />
          <EditValueNumpad />
          <ActionNavigation />
          <HmiToastStack />
          <AlarmPopup />
          <FullscreenPrompt />
        </div>
      </PageDataSettleGate>
      {/* Outside the zoomed root so it covers the viewport. */}
      <ConnectionLostOverlay />
    </HmiScopeContext.Provider>
  );
}
