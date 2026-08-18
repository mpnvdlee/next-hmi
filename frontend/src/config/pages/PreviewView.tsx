/**
 * PreviewView — full HMI shell rendered inside the editor live-preview iframe.
 *
 * Loaded at /preview/:pageId. Imports runtime HMI styles plus the small set of
 * shared config utility classes used by the checkerboard/empty-state chrome;
 * it never imports editor component styles.
 *
 * postMessage bridge (same-origin):
 *   INBOUND  { type: 'pages_update',  pages, header, footer, dialogs, pageContent }
 *            → replaces the config store so tree edits appear live.
 *            pageContent: Record<pageId, children[]> carries loaded page component content.
 *   INBOUND  { type: 'set_selected',  ids: string[], lead: string | null }
 *            → adds a preview selection class to every matching widget or page
 *            group; `lead` is the one the preview scrolls into view.
 *   OUTBOUND { type: 'component_clicked', id: string, pathIds?: string[], toggle?: boolean }
 *            → fires when the user clicks a component in the preview. `pathIds`
 *            carries the ancestor chain when the click resolved through one;
 *            `toggle` reports a ctrl/cmd-click.
 *   OUTBOUND { type: 'preview_context_menu', pathIds: string[], x, y }
 *            → fires on right-click so the editor can open its own menu there.
 *
 * Special virtual pageId values handled:
 *   '__header__' → shows only the user-defined header area
 *   '__footer__' → shows only the user-defined footer area
 *   <dialogId>   → shows a dialog's components in a dashed preview box
 *   <pageId>    → normal page render
 */

import '@config/styles/config.css';
import '@hmi/styles/hmi.css';
import '@hmi/styles/hmi-view.css';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSWithVars } from '@shared/types/style';
import { useParams, useNavigate } from 'react-router-dom';
import { usePage, usePages } from '@shared/hooks/useConfig';
import { useTranslations } from '@shared/hooks/useTranslations';
import { useConfigStore } from '@shared/store/configStore';
import { useTranslationStore } from '@shared/store/translationStore';
import { useComponentStore } from '@shared/store/componentStore';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { useVariableStore } from '@hmi/store/variableStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import { HmiScopeContext } from '@hmi/context/HmiScopeContext';
import { AlertModal } from '@hmi/components/AlertModal';
import { HmiToastStack } from '@hmi/components/ToastStack';
import { ModalStack } from '@hmi/components/ModalStack';
import CloseButton from '@shared/components/CloseButton';
import {
  EMPTY_PAGE_GROUPS,
  resolveMainStyle,
  resolvePageContext,
  mapPages,
  findPageById,
} from '@shared/utils/pageTree';
import { getPageChildren } from '@shared/utils/pageContent';
import type { WidgetConfig } from '@shared/types/config';
import type { ComponentDefinition } from '@shared/types/componentTypes';
import type { ThemeConfig } from '@shared/types/theme';
import NavigationMenu from '@hmi/components/NavigationMenu';
import WidgetRenderer from '@hmi/components/WidgetRenderer';
import { renderRegionChildren } from '@hmi/components/renderRegion';
import ShellRegion from '@hmi/components/ShellRegion';
import { useSidebarFullHeight } from '@hmi/components/ShellRegion/useSidebarFullHeight';
import PageGroupPageView from '@hmi/components/PageGroupPageView';
import { collectComponentPriorityKeys } from '@hmi/components/layoutUtils';
import { PreviewContext } from '@shared/context/PreviewContext';
import { PreviewSelectionContext } from '@hmi/context/PreviewSelectionContext';
import { applyPreviewTheme, LS_THEME_PREVIEW } from '@shared/utils/themeTokens';
import { installPreviewInteractionGuard } from './previewInteractionGuard';
import { selectionModifiers, type SelectionModifiers } from '@shared/utils/domEvent';

/** Ids of the clicked node and its widget ancestors, innermost first.
 *
 *  Nodes a reusable component's definition draws are skipped: they are not in
 *  the tree the editor is editing, so a click on one belongs to the instance
 *  further out. Widgets the caller dropped into the instance's slots carry no
 *  such marker and stay in, which is what makes them selectable in place. */
function collectComponentPathIdsFromTarget(target: Element): string[] {
  const ids: string[] = [];
  let current = target.closest('[data-widget-id]') as HTMLElement | null;
  while (current) {
    const id = current.getAttribute('data-widget-id');
    if (id && current.getAttribute('data-widget-source') !== 'definition') ids.push(id);
    current = current.parentElement?.closest('[data-widget-id]') as HTMLElement | null;
  }
  return ids;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export default function PreviewView() {
  // Data comes exclusively via postMessage from the parent editor iframe.
  // Do NOT call useConfig() here — it would race with postMessage and
  // overwrite in-memory changes with stale backend data.
  useTranslations();
  const navigate = useNavigate();

  const { pageId: areaId } = useParams<{ pageId: string }>();
  const pages = useConfigStore((s) => s.pages);
  const header = useConfigStore((s) => s.header);
  const footer = useConfigStore((s) => s.footer);
  const leftSidebar = useConfigStore((s) => s.leftSidebar);
  const rightSidebar = useConfigStore((s) => s.rightSidebar);
  const shell = useConfigStore((s) => s.shell);
  const dialogs = useConfigStore((s) => s.dialogs);
  const wsConnected = useVariableStore((s) => s.wsConnected);
  const openDialogEntries = useHmiStore((s) => s.openDialogs);
  const openPageOverlayEntries = useHmiStore((s) => s.openPageOverlays);
  const trustedParentOrigin = window.location.origin;

  // Track the selected component ids from the editor's set_selected messages.
  // Stored as React state so the DOM highlight is applied in a layout effect —
  // i.e. after React finishes rendering any pages_update changes.
  const [previewSelectedIds, setPreviewSelectedIds] = useState<string[]>([]);
  // The id most recently *added* to the selection, which is the only one worth
  // scrolling to. Null for a removal — otherwise ctrl-clicking a widget off the
  // selection would yank the canvas back to another member.
  const [previewSelectionLead, setPreviewSelectionLead] = useState<string | null>(null);
  // 'config' (default): clicks pick components for editing but actions and
  // page-switching are blocked. 'test': normal HMI interactivity.
  const [previewMode, setPreviewMode] = useState<'config' | 'test'>('config');
  const layoutRef = useRef<HTMLDivElement>(null);
  // Last id we scrolled to, so we scroll once per selection change (the effect
  // below runs on every render) rather than yanking the viewport continuously.
  const lastScrolledLeadRef = useRef<string | null>(null);

  // Rebuilt only when the selection changes, so window items don't re-run their
  // force-mount memo on every render (see PreviewSelectionContext).
  const previewSelectionSet = useMemo(
    () => new Set(previewSelectedIds) as ReadonlySet<string>,
    [previewSelectedIds],
  );

  // Apply / remove the selection highlight after every render (no deps intentional:
  // must re-apply when the selection changes AND when pages_update rebuilds the DOM).
  // useLayoutEffect fires synchronously after DOM mutations to avoid a one-frame flash.
  useLayoutEffect(() => {
    const root = layoutRef.current ?? document.body;
    root
      .querySelectorAll('.hmi-preview-node--selected')
      .forEach((el) => el.classList.remove('hmi-preview-node--selected'));
    root
      .querySelectorAll('.hmi-page-group--selected')
      .forEach((el) => el.classList.remove('hmi-page-group--selected'));
    // Forget the recorded lead as soon as it leaves the selection: re-adding it
    // later is a new lead and must scroll again.
    const scrolledLead = lastScrolledLeadRef.current;
    if (scrolledLead !== null && !previewSelectedIds.includes(scrolledLead)) {
      lastScrolledLeadRef.current = null;
    }
    if (previewSelectedIds.length === 0) return;
    // Selecting an off-screen widget from the tree force-mounts it (windowing
    // keeps its item mounted via PreviewSelectionContext); bring it into view.
    // Only the lead is scrolled to — the rest may be anywhere on the page.
    const scrollToSelection = (el: Element, id: string) => {
      if (id !== previewSelectionLead || lastScrolledLeadRef.current === id) return;
      lastScrolledLeadRef.current = id;
      // The `.hmi-preview-node` wrapper (and chromeless page-group marks) are
      // `display: contents`, so they generate no box and `scrollIntoView` on
      // them is a no-op. Descend to the first descendant that has a box.
      let target: Element = el;
      while (target.getClientRects().length === 0 && target.firstElementChild) {
        target = target.firstElementChild;
      }
      // `scroll-margin` on the target (set in WidgetRenderer.css) keeps the
      // widget off the scrollport edges instead of landing flush against them.
      target.scrollIntoView({ block: 'nearest' });
    };
    for (const id of previewSelectedIds) {
      const wrapper = root.querySelector(`[data-widget-id="${CSS.escape(id)}"]`);
      if (wrapper) {
        wrapper.classList.add('hmi-preview-node--selected');
        scrollToSelection(wrapper, id);
        continue;
      }
      const pageGroup = root.querySelector(`[data-page-group-id="${CSS.escape(id)}"]`);
      if (!pageGroup) continue;
      // Chromeless groups use `display: contents`, which cannot draw an
      // outline. Apply the selection class to their first box-producing
      // descendant while retaining the group wrapper as the lookup contract.
      let highlightTarget = pageGroup;
      while (highlightTarget.getClientRects().length === 0 && highlightTarget.firstElementChild) {
        highlightTarget = highlightTarget.firstElementChild;
      }
      highlightTarget.classList.add('hmi-page-group--selected');
      scrollToSelection(highlightTarget, id);
    }
  });

  useEffect(() => {
    // Prefer the Themes view's unsaved draft. AppInner's boot load covers the
    // saved theme; pinning keeps it from repainting over the draft.
    try {
      const raw = localStorage.getItem(LS_THEME_PREVIEW);
      if (!raw) return;
      const payload = JSON.parse(raw) as { theme?: ThemeConfig };
      if (payload.theme) applyPreviewTheme(payload.theme);
    } catch {
      // Ignore malformed payload; the boot load already applied the saved theme.
    }
  }, []);

  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key !== LS_THEME_PREVIEW || !event.newValue) return;
      try {
        const payload = JSON.parse(event.newValue) as { theme?: ThemeConfig };
        if (!payload.theme) return;
        applyPreviewTheme(payload.theme);
      } catch {
        // Ignore malformed preview payloads.
      }
    }

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const isHeader = areaId === '__header__';
  const isFooter = areaId === '__footer__';
  const isLeftSidebar = areaId === '__leftSidebar__';
  const isRightSidebar = areaId === '__rightSidebar__';
  const isShellArea = isHeader || isFooter || isLeftSidebar || isRightSidebar;
  const dialog = !isShellArea ? dialogs.find((p) => p.id === areaId) : undefined;
  const { page, pageGroups } =
    !isShellArea && !dialog
      ? resolvePageContext(pages, areaId)
      : { page: null, pageGroups: EMPTY_PAGE_GROUPS };

  // Hydrate page content when the route changes (tab switch, link navigation).
  // Mirrors HmiView — the preview can safely fetch individual page content from
  // the backend; only useConfig() is avoided to prevent overwriting in-memory edits.
  usePage(page?.id);
  const openPageOverlayIds = openPageOverlayEntries.map((e) => e.pageId);
  usePages(openPageOverlayIds);
  const openDialogs = openDialogEntries
    .map((entry) => dialogs.find((d) => d.id === entry.id))
    .filter((d): d is NonNullable<typeof d> => Boolean(d));
  const openPageOverlays = openPageOverlayEntries
    .map((entry) => ({ entry, page: findPageById(pages, entry.pageId) }))
    .filter((item): item is { entry: typeof item.entry; page: NonNullable<typeof item.page> } =>
      Boolean(item.page),
    );

  // The preview can contain unsaved bindings that the backend cannot discover
  // from the persisted page. Track the visible binding set separately from the
  // component-tree object identities so only binding edits refresh context.
  const previewPriorityKeys = collectComponentPriorityKeys([
    ...(page ? getPageChildren(page) : []),
    ...header,
    ...footer,
    ...leftSidebar,
    ...rightSidebar,
    ...(dialog?.widgets ?? []),
    ...openPageOverlays.flatMap((item) => getPageChildren(item.page)),
    ...openDialogs.flatMap((d) => d.widgets),
  ]);
  const previewPriorityKeySignature = [...previewPriorityKeys].sort().join('\u0000');

  // Keep the parent editor synced with the actual iframe route. Selection is
  // owned by the parent editor, so preserve the last set_selected value across
  // an in-iframe route change. Clearing it here can desynchronise the iframe
  // when selecting a widget also switches the active editor tab: the parent
  // still has that widget selected and therefore has no state change to resend.
  useEffect(() => {
    if (!areaId) return;
    window.parent.postMessage({ type: 'preview_location', pageId: areaId }, trustedParentOrigin);
  }, [areaId, trustedParentOrigin]);

  // `toggle` rides along so the parent — which owns the selection — can decide
  // between extending and replacing. There is no canvas equivalent of a Shift
  // range: tree order is not visual order, so `range` is never reported.
  const reportPreviewSelection = useCallback(
    (target: Element, mods: SelectionModifiers) => {
      const pathIds = collectComponentPathIdsFromTarget(target);
      if (pathIds.length > 0) {
        window.parent.postMessage(
          { type: 'component_clicked', id: pathIds[0], pathIds, toggle: mods.toggle },
          trustedParentOrigin,
        );
        return;
      }

      const groupWrapper = target.closest('[data-page-group-id]');
      if (groupWrapper) {
        const id = groupWrapper.getAttribute('data-page-group-id');
        window.parent.postMessage(
          { type: 'component_clicked', id, toggle: mods.toggle },
          trustedParentOrigin,
        );
      }
    },
    [trustedParentOrigin],
  );

  // Coordinates are iframe-viewport-relative; the parent maps them onto its own
  // viewport using the iframe's rect and preview scale.
  const reportPreviewContextMenu = useCallback(
    (target: Element, x: number, y: number) => {
      window.parent.postMessage(
        {
          type: 'preview_context_menu',
          pathIds: collectComponentPathIdsFromTarget(target),
          x,
          y,
        },
        trustedParentOrigin,
      );
    },
    [trustedParentOrigin],
  );

  // Pointer events do not cross the iframe boundary. Notify the editor parent
  // explicitly so open menus dismiss on every preview click, including
  // repeated clicks that do not trigger another window blur.
  useEffect(() => {
    const notifyParent = () => {
      window.parent.postMessage({ type: 'preview_pointer_down' }, trustedParentOrigin);
    };
    window.addEventListener('pointerdown', notifyParent, true);
    return () => window.removeEventListener('pointerdown', notifyParent, true);
  }, [trustedParentOrigin]);

  // Keyboard events don't cross the iframe boundary either — forward the
  // browser zoom shortcuts (blocked from native zoom by useDisableBrowserZoom)
  // so they still drive the parent editor's Scaling control when focus is
  // inside the preview.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key !== '+' && e.key !== '=' && e.key !== '-' && e.key !== '0') return;
      e.preventDefault();
      const action = e.key === '0' ? 'reset' : e.key === '-' ? 'out' : 'in';
      window.parent.postMessage({ type: 'preview_zoom', action }, trustedParentOrigin);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [trustedParentOrigin]);

  // A click-only React handler is too late for native controls: selects open
  // and fields focus on pointer/mouse down. Guard the entire iframe document so
  // every widget (including portal content) is non-interactive in config mode.
  useEffect(() => {
    if (previewMode !== 'config') return;
    return installPreviewInteractionGuard(
      document,
      reportPreviewSelection,
      reportPreviewContextMenu,
    );
  }, [previewMode, reportPreviewSelection, reportPreviewContextMenu]);

  // Request auto-login identity for the preview scope when WS connects.
  useEffect(() => {
    if (!wsConnected) return;
    sendWsMessage({ type: 'request_identity', scope: 'runtime:preview' });
  }, [wsConnected]);

  // Tell the backend the active preview context.
  useEffect(() => {
    if (!wsConnected) return;

    // For special preview routes (__header__/__footer__/__leftSidebar__/__rightSidebar__),
    // send the route id so subscriptions stay active even when no concrete page is selected.
    const currentPageId = page?.id ?? (isShellArea ? areaId : undefined);
    const currentPageIds = currentPageId
      ? [currentPageId, ...openPageOverlayIds]
      : [...openPageOverlayIds];

    sendWsMessage({
      type: 'set_context',
      currentPageIds,
      openDialogIds: [...(dialog ? [dialog.id] : []), ...openDialogEntries.map((d) => d.id)],
      priorityKeys: previewPriorityKeys,
    });

    // Component-tree references are intentionally omitted. The sorted binding-key
    // signature below re-sends context for binding edits without doing so for
    // unrelated visual/property edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    wsConnected,
    page?.id,
    dialog?.id,
    isShellArea,
    areaId,
    openPageOverlayEntries,
    openDialogEntries,
    previewPriorityKeySignature,
  ]);

  // Clear this preview client's context only when the iframe truly unmounts.
  // Keeping cleanup separate avoids clearing all subscriptions immediately
  // before a binding edit sends its replacement context.
  useEffect(() => {
    return () => {
      sendWsMessage({ type: 'set_context', currentPageIds: [], openDialogIds: [] });
    };
  }, []);

  // ── inbound: editor → preview ──────────────────────────────────────────────
  useEffect(() => {
    function handleMsg(event: MessageEvent) {
      if (event.origin !== trustedParentOrigin) return;
      if (event.source !== window.parent) return;
      if (event.data?.type === 'translations_update') {
        useTranslationStore.getState().applyTranslationsUpdate({
          languages: event.data.languages ?? [],
          translations: event.data.translations ?? {},
        });
        return;
      }

      if (event.data?.type === 'components_update') {
        const drafts =
          (event.data.draftComponents as Record<string, ComponentDefinition> | undefined) ?? {};
        const incoming = event.data.components as ComponentDefinition[] | undefined;
        useComponentStore.setState({
          draftComponents: drafts,
          ...(incoming !== undefined ? { components: incoming, loaded: true } : {}),
        });
        return;
      }

      if (event.data?.type === 'pages_update') {
        const store = useConfigStore.getState();
        // The parent sends a pageContent map with loaded pages' component children.
        // Merge each one into the pages array so individual pages render correctly.
        const pageContent = event.data.pageContent as Record<string, WidgetConfig[]> | undefined;
        const incomingPages = event.data.pages ?? [];
        const hydratedPages =
          pageContent && Object.keys(pageContent).length > 0
            ? mapPages(incomingPages, (page) =>
                pageContent[page.id] !== undefined
                  ? { ...page, children: pageContent[page.id] }
                  : page,
              )
            : incomingPages;
        store.setPages(hydratedPages);
        store.setHeader(event.data.header ?? []);
        store.setFooter(event.data.footer ?? []);
        store.setLeftSidebar(event.data.leftSidebar ?? []);
        store.setRightSidebar(event.data.rightSidebar ?? []);
        store.setShell(event.data.shell ?? {});
        store.setDialogs(event.data.dialogs ?? []);
        store.setGlobalEvents(event.data.globalEvents ?? {});
        return;
      }

      if (event.data?.type === 'navigate_preview') {
        const nextPageId = event.data.pageId as string | undefined;
        if (!nextPageId || nextPageId === areaId) return;
        navigate(`/preview/${nextPageId}`, { replace: event.data.replace ?? false });
        return;
      }

      if (event.data?.type === 'set_mode') {
        const mode = event.data.mode === 'test' ? 'test' : 'config';
        setPreviewMode(mode);
        return;
      }

      if (!event.data || event.data.type !== 'set_selected') return;
      const ids = event.data.ids;
      const nextIds = Array.isArray(ids) ? (ids as string[]) : [];
      // Every click echoes the selection back, unchanged ones included. Keeping the
      // previous array identity keeps that a real no-op: a fresh array would rebuild
      // previewSelectionSet and re-run every window item's force-mount memo.
      setPreviewSelectedIds((prev) => (sameIds(prev, nextIds) ? prev : nextIds));
      setPreviewSelectionLead((event.data.lead as string | null) ?? null);
    }

    window.addEventListener('message', handleMsg);
    // Tell the parent editor we're ready to receive data
    window.parent.postMessage({ type: 'preview_ready' }, trustedParentOrigin);
    return () => window.removeEventListener('message', handleMsg);
  }, [areaId, navigate, trustedParentOrigin]);

  // ── click: intercept nav links + report component clicks ──────────────────
  // In test mode, capture navigation before child handlers change the route.
  function handleLayoutClick(e: React.MouseEvent<HTMLDivElement>) {
    // Always: report selection to parent editor.
    reportPreviewSelection(e.target as Element, selectionModifiers(e));

    // Test mode: redirect /pages/:id → /preview/:id so navigation stays in preview.
    const anchor = (e.target as HTMLElement).closest('a[href]');
    if (anchor) {
      const href = anchor.getAttribute('href');
      if (href?.startsWith('/pages/')) {
        e.preventDefault();
        navigate(`/preview/${href.slice('/pages/'.length)}`);
      }
    }
  }

  // CSS `zoom` on the wrapper scales both .hmi-layout and the position:fixed
  // overlays (alerts, toasts). `--hmi-scale` lets .hmi-root inverse-size the
  // viewport so the zoomed layout still fills it.
  const rootStyle: CSSWithVars =
    shell.hmiScale && shell.hmiScale !== 1
      ? { zoom: shell.hmiScale, '--hmi-scale': shell.hmiScale }
      : {};

  // Config mode never delivers clicks to widgets (see the document guard), so
  // hover/active CSS transitions that imply interactivity would be misleading.
  const rootClassName = `hmi-root${previewMode === 'config' ? ' hmi-root--config-mode' : ''}${
    shell.showScrollbars ? ' hmi-root--scrollbars' : ''
  }`;

  const {
    left: leftFullHeight,
    right: rightFullHeight,
    any: hasFullHeightSidebar,
  } = useSidebarFullHeight(shell.leftSidebar ?? {}, shell.rightSidebar ?? {});

  // ── Dialog: render as a compact modal card on a plain background ────────────
  if (dialog) {
    return (
      <HmiScopeContext.Provider value="runtime:preview">
        <PreviewContext.Provider value={true}>
          <div className={rootClassName} style={rootStyle}>
            <div
              className="hmi-dialog-preview cfg-checkerboard-bg"
              onClickCapture={handleLayoutClick}
              ref={layoutRef}
            >
              <div className="hmi-modal">
                <div className="hmi-modal__header">
                  <span className="hmi-modal__title">{dialog.title}</span>
                  {dialog.showCloseButton && <CloseButton className="hmi-modal__close" />}
                </div>
                <div className="hmi-modal__content">
                  {dialog.widgets.length > 0 ? (
                    dialog.widgets.map((comp) => <WidgetRenderer key={comp.id} node={comp} />)
                  ) : (
                    <p className="hmi-no-page">Dialog is empty — add components via the tree.</p>
                  )}
                </div>
              </div>
            </div>
            <AlertModal scope="runtime:preview" />
            <HmiToastStack />
          </div>
        </PreviewContext.Provider>
      </HmiScopeContext.Provider>
    );
  }

  const renderRegion = (
    components: WidgetConfig[],
    focused: boolean,
    emptyHint: string,
    fallback: React.ReactNode = null,
  ): React.ReactNode =>
    renderRegionChildren(
      components,
      focused ? <span className="hmi-area--empty-hint">{emptyHint}</span> : fallback,
    );

  const headerContent = renderRegion(header, isHeader, 'Header area — add components via the tree');
  const footerContent = renderRegion(footer, isFooter, 'Footer area — add components via the tree');
  const leftSidebarContent = renderRegion(
    leftSidebar,
    isLeftSidebar,
    'Left sidebar — add components via the tree',
    <NavigationMenu />,
  );
  const rightSidebarContent = renderRegion(
    rightSidebar,
    isRightSidebar,
    'Right sidebar — add components via the tree',
  );

  return (
    <HmiScopeContext.Provider value="runtime:preview">
      <PreviewContext.Provider value={true}>
        <PreviewSelectionContext.Provider value={previewSelectionSet}>
          <div className={rootClassName} style={rootStyle}>
            <div
              className={`hmi-layout${hasFullHeightSidebar ? ' hmi-layout--row' : ''}`}
              onClickCapture={handleLayoutClick}
              ref={layoutRef}
            >
              {leftFullHeight && (
                <ShellRegion
                  id="leftSidebar"
                  config={shell.leftSidebar ?? {}}
                  focused={isLeftSidebar}
                >
                  {leftSidebarContent}
                </ShellRegion>
              )}
              <div className="hmi-layout__column">
                <ShellRegion id="header" config={shell.header ?? {}} focused={isHeader}>
                  {headerContent}
                </ShellRegion>
                <div className="hmi-body">
                  {!leftFullHeight && (
                    <ShellRegion
                      id="leftSidebar"
                      config={shell.leftSidebar ?? {}}
                      focused={isLeftSidebar}
                    >
                      {leftSidebarContent}
                    </ShellRegion>
                  )}
                  <main className="hmi-main" style={resolveMainStyle(pageGroups, page)}>
                    {!isShellArea ? (
                      <PageGroupPageView
                        pages={pages}
                        requestedId={areaId}
                        onNavigate={(pageId, replace) =>
                          navigate(`/preview/${pageId}`, { replace: replace ?? false })
                        }
                        emptyMessage="No page found."
                      />
                    ) : null}
                  </main>
                  {!rightFullHeight && (
                    <ShellRegion
                      id="rightSidebar"
                      config={shell.rightSidebar ?? {}}
                      focused={isRightSidebar}
                    >
                      {rightSidebarContent}
                    </ShellRegion>
                  )}
                </div>
                <ShellRegion id="footer" config={shell.footer ?? {}} focused={isFooter}>
                  {footerContent}
                </ShellRegion>
              </div>
              {rightFullHeight && (
                <ShellRegion
                  id="rightSidebar"
                  config={shell.rightSidebar ?? {}}
                  focused={isRightSidebar}
                >
                  {rightSidebarContent}
                </ShellRegion>
              )}
              <ModalStack />
            </div>
            <AlertModal scope="runtime:preview" />
            <HmiToastStack />
          </div>
        </PreviewSelectionContext.Provider>
      </PreviewContext.Provider>
    </HmiScopeContext.Provider>
  );
}
