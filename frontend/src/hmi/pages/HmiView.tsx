import '../styles/hmi.css';
import '../styles/hmi-view.css';
import { useDeferredValue, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useConfig, usePage, usePages } from '@shared/hooks/useConfig';
import { useTranslations } from '@shared/hooks/useTranslations';
import { useConfigStore } from '@shared/store/configStore';
import { useHmiStore } from '../store/hmiStore';
import { sendWsMessage } from '../hooks/useWebSocket';
import { useVariableStore } from '../store/variableStore';
import { resolveMainStyle, resolvePageContext } from '@shared/utils/pageTree';
import { getPageChildren } from '@shared/utils/pageContent';
import { HmiScopeContext } from '../context/HmiScopeContext';
import { useResolvedDialogs, useResolvedPageOverlays } from '../hooks/useOpenOverlays';
import NavigationMenu from '../components/NavigationMenu';
import { renderRegionChildren } from '../components/renderRegion';
import ShellRegion from '../components/ShellRegion';
import { useSidebarFullHeight } from '../components/ShellRegion/useSidebarFullHeight';
import PageGroupPageView from '../components/PageGroupPageView';
import { SHELL_REGION_IDS, type ShellConfig, type ShellRegionConfig } from '@shared/types/config';
import type { CSSWithVars } from '@shared/types/style';
import { ModalStack } from '../components/ModalStack';
import { AlertModal } from '../components/AlertModal';
import { HmiToastStack } from '../components/ToastStack';
import AlarmPopup from '../components/AlarmPopup';
import { FullscreenPrompt } from '../components/FullscreenPrompt';
import BootSplash from '../components/BootSplash';
import { markBooted, useBootHold } from '../components/BootSplash/bootHold';
import { collectComponentPriorityKeys } from '../components/layoutUtils';
import { ContentSpinner } from '@shared/components/Spinner';
import { useGlobalEvents } from '../hooks/useGlobalEvents';

export default function HmiView() {
  useConfig();
  useTranslations();

  // Theme loading and cross-tab theme-save sync are owned by AppInner, which
  // starts them before any view mounts.

  // Generate a stable unique scope key for this HMI view instance.
  // Created once on first mount; remounted instances get a new key.
  const hmiKeyRef = useRef<string | null>(null);
  if (hmiKeyRef.current === null) {
    hmiKeyRef.current = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  }
  const scope = `runtime:${hmiKeyRef.current}`;

  useGlobalEvents(scope);

  const { id } = useParams<{ id: string }>();
  // Render the (potentially heavy) page from a deferred id so switching pages
  // stays interruptible: the URL/menu update urgently while the page render and
  // the outgoing page's teardown run at low priority. `pageSwitching` is true
  // during that window so we can cover the swap with a spinner overlay.
  const deferredId = useDeferredValue(id);
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
  const openDialogEntries = useHmiStore((s) => s.openDialogs);
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
  // Derive overlay IDs first so usePages can use them.
  const openPageOverlayIds = openPageOverlayEntries.map((e) => e.pageId);
  // Hydrate content for every open overlay page so their component children are available.
  usePages(openPageOverlayIds);
  const openDialogs = useResolvedDialogs().map((d) => d.dialog);
  const openPageOverlays = useResolvedPageOverlays();

  // Request auto-login identity for this scope when WS connects (or reconnects).
  useEffect(() => {
    if (!wsConnected) return;
    sendWsMessage({ type: 'request_identity', scope });
  }, [wsConnected, scope]);

  // Send active runtime context. Backend computes the full variable set so
  // nested expressions (for example $if/$switch/$compare) are included.
  // Additionally, derive explicit priorityKeys from the in-memory component
  // tree so the backend subscribes variables even before config is saved to disk.
  useEffect(() => {
    if (!wsConnected) return;

    const currentPageIds = page?.id ? [page.id, ...openPageOverlayIds] : [...openPageOverlayIds];

    // Walk the visible component tree to collect $var binding keys. These are
    // sent as priorityKeys so the backend can push values without needing the
    // page config to be saved to disk first.
    const components = [
      ...(page ? getPageChildren(page) : []),
      ...header,
      ...footer,
      ...leftSidebar,
      ...rightSidebar,
      ...openPageOverlays.flatMap((item) => getPageChildren(item.page)),
      ...openDialogs.flatMap((d) => d.widgets),
    ];
    const priorityKeys = collectComponentPriorityKeys(components);

    sendWsMessage({
      type: 'set_context',
      currentPageIds,
      openDialogIds: openDialogEntries.map((d) => d.id),
      priorityKeys,
    });
    // page, header, footer, openDialogs, openPageOverlays are intentionally
    // omitted from deps: page?.id already re-triggers on navigation, and we
    // do NOT want to re-send set_context on every component edit in the
    // config editor while the HMI view is active.
    // openPageOverlayEntries (Zustand state) changes reference only when overlays
    // are actually added/removed, avoiding spurious re-fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsConnected, page?.id, openDialogEntries, openPageOverlayEntries]);

  // Clear this client's runtime context only on true unmount (navigating away
  // from the HMI view entirely). Deliberately a separate, empty-deps effect:
  // folding this into the effect above would fire its cleanup — and so this
  // "clear" send — before every re-run, doubling the set_context traffic (and
  // the backend's OPC-UA priority-subscription recompute) on every ordinary
  // page navigation or dialog/overlay toggle.
  useEffect(() => {
    return () => {
      sendWsMessage({ type: 'set_context', currentPageIds: [], openDialogIds: [] });
    };
  }, []);

  // Merge per-page override on top of the project shell.
  const resolvedShell: ShellConfig = mergeShell(shell, page?.shellOverride);
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

  // When leftSidebar is empty, fall back to the built-in NavigationMenu so the
  // zero-config runtime keeps a navigation surface.
  const headerCfg: ShellRegionConfig = resolvedShell.header ?? {};
  const footerCfg: ShellRegionConfig = resolvedShell.footer ?? {};
  const leftSidebarCfg: ShellRegionConfig = resolvedShell.leftSidebar ?? {};
  const rightSidebarCfg: ShellRegionConfig = resolvedShell.rightSidebar ?? {};

  const headerContent = renderRegionChildren(header);
  const footerContent = renderRegionChildren(footer);
  const leftSidebarContent = renderRegionChildren(leftSidebar, <NavigationMenu />);
  const rightSidebarContent = renderRegionChildren(rightSidebar);

  const {
    left: leftFullHeight,
    right: rightFullHeight,
    any: hasFullHeightSidebar,
  } = useSidebarFullHeight(leftSidebarCfg, rightSidebarCfg);

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

  const pageView = (
    <PageGroupPageView
      pages={pages}
      requestedId={deferredId}
      onNavigate={(pageId, replace) => {
        // Navigate urgently so the URL/menu react immediately; the deferred
        // requestedId keeps the actual page render/teardown at low priority.
        navigate(`/pages/${pageId}`, { replace: replace ?? false });
      }}
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

  return (
    <HmiScopeContext.Provider value={scope}>
      <div className={rootClassName} style={rootStyle}>
        <div className={`hmi-layout${hasFullHeightSidebar ? ' hmi-layout--row' : ''}`}>
          {leftFullHeight && leftSidebarRegion}
          <div className="hmi-layout__column">
            <ShellRegion id="header" config={headerCfg}>
              {headerContent}
            </ShellRegion>
            <div className="hmi-body">
              {!leftFullHeight && leftSidebarRegion}
              <main className="hmi-main" style={mainStyle}>
                {pageView}
                {pageSwitching && (
                  <div className="hmi-page-pending" aria-hidden>
                    <ContentSpinner />
                  </div>
                )}
              </main>
              {!rightFullHeight && rightSidebarRegion}
            </div>
            <ShellRegion id="footer" config={footerCfg}>
              {footerContent}
            </ShellRegion>
          </div>
          {rightFullHeight && rightSidebarRegion}
          <ModalStack />
        </div>
        <AlertModal scope={scope} />
        <HmiToastStack />
        <AlarmPopup />
        <FullscreenPrompt />
      </div>
    </HmiScopeContext.Provider>
  );
}

/**
 * Deep-merge a per-page ShellConfig override on top of the project ShellConfig.
 * Each region merges field-by-field so an override patch like
 * `{ leftSidebar: { defaultState: 'hidden' } }` keeps the project's other
 * region settings (expandedSize, overlay, …) intact.
 */
function mergeShell(
  base: ShellConfig | undefined,
  override: Partial<ShellConfig> | undefined,
): ShellConfig {
  if (!override) return base ?? {};
  const out: ShellConfig = { ...base };
  for (const id of SHELL_REGION_IDS) {
    if (override[id] === undefined) continue;
    out[id] = { ...(base?.[id] ?? {}), ...override[id] };
  }
  return out;
}
