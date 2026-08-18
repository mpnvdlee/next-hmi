/**
 * LivePreview — centre panel of /editor.
 *
 * Renders an <iframe src="/preview/:pageId"> and brokers the two-way
 * postMessage selection protocol:
 *
 *   Parent → iframe: { type: 'set_selected',    ids: string[], lead: string | null }
 *   iframe → Parent: { type: 'component_clicked', id: string, pathIds?: string[], toggle?: boolean }
 *   iframe → Parent: { type: 'preview_context_menu', pathIds: string[], x, y }
 *
 * `lead` is the row the click landed on — the only one worth scrolling to;
 * a full resync into a freshly loaded preview sends the current lead instead.
 * `toggle` reports a ctrl/cmd-click; the parent owns the selection and so decides
 * between extending and replacing.
 *
 * A right-click in the preview opens the editor's own add-widget menu here,
 * positioned over the iframe (the native menu is suppressed inside it).
 *
 * Also provides a viewport selector that resizes the iframe wrapper via
 * CSS custom properties --preview-w / --preview-h on .editor-preview-wrapper.
 */

import './style.css';
import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import TabBar from '../TabBar';
import { PencilSimple, Play, Plus, Minus } from '@phosphor-icons/react';
import ViewportSelector from '../ViewportSelector';
import { VIEWPORTS } from '../viewportPresets';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useConfigStore } from '@shared/store/configStore';
import { useTranslationStore } from '@shared/store/translationStore';
import { useComponentStore } from '@shared/store/componentStore';
import { findPageNodeById, flattenPages, isPageGroup, treeContains } from '@shared/utils/pageTree';
import { getPageChildren } from '@shared/utils/pageContent';
import { withBase } from '@shared/utils/runtimeBase';
import {
  EDITOR_NODE_IDS,
  SHELL_AREA_LABELS,
  type EditorRegion,
} from '@shared/constants/editorSentinels';
import { findInPages, isFound } from '@shared/utils/widgetTree';
import type { CSSWithVars } from '@shared/types/style';
import ConfigWorkspace from '@config/components/ui/ConfigWorkspace';
import WidgetSelector from '@config/components/ui/WidgetSelector';
import PreviewContextMenu from './PreviewContextMenu';
import { resolvePreviewInsertTarget, type PreviewInsertTarget } from './previewInsertTarget';
import { insertComponentInto } from '../WidgetTree/insertComponent';
import {
  findWidgetEverywhere,
  clipboardKind,
  clipboardNodeIds,
  dispatchPaste,
  kindForSelectedId,
  projectFromStore,
  resolveCopyEntry,
} from '../WidgetTree/clipboardDispatch';
import { canExtendWith, verbTargets } from '@config/store/domains/selectionScope';
import { copyTreeNode, pasteToast, readTreeNodeFromClipboard } from '../WidgetTree/clipboardOps';
import { clearCut, setCut } from '../WidgetTree/cutState';
import { deleteWidgetsKeepingSelection } from '../WidgetTree/deleteSelection';
import type { NodeKind } from '../WidgetTree/types';
import { makeComponentOfType, makeDefaultContainer } from '../WidgetTree/treeUtils';
import { collectAllIds } from '@shared/store/configStoreHelpers';

const TRUSTED_ORIGIN = window.location.origin;

const SCALE_MIN = 50;
const SCALE_MAX = 200;
const SCALE_STEP = 10;
const clampScale = (pct: number) => Math.min(Math.max(pct, SCALE_MIN), SCALE_MAX);

/** Shell regions map onto a shell sentinel id, so their label comes from `SHELL_AREA_LABELS`
 *  (the single source of truth) rather than a second, parallel set of label strings. */
const REGION_SHELL_NODE_ID: Partial<Record<EditorRegion, string>> = {
  header: EDITOR_NODE_IDS.HEADER,
  footer: EDITOR_NODE_IDS.FOOTER,
  leftSidebar: EDITOR_NODE_IDS.LEFT_SIDEBAR,
  rightSidebar: EDITOR_NODE_IDS.RIGHT_SIDEBAR,
};

/** Selection equality: same ids in the same order, so the lead (the last entry) counts. */
function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * The row the preview should scroll to: the one the click landed on, which is
 * normally the id that joined the selection last.
 *
 * A Shift-range is the exception. It always arrives in document order, so a range
 * extended *upward* leaves its anchor last and the clicked row first — scrolling to
 * either the lead or the newest id would land a row short of where the user clicked.
 * Nothing to scroll to when the change only removed ids.
 */
function clickedLead(ids: string[], added: string[], anchorId: string | null): string | null {
  const extendedUpward =
    anchorId !== null && anchorId === ids[ids.length - 1] && !added.includes(anchorId);
  const clicked = extendedUpward ? added[0] : added[added.length - 1];
  return clicked ?? null;
}

function regionLabel(region: EditorRegion): string {
  const shellNodeId = REGION_SHELL_NODE_ID[region];
  if (shellNodeId) return SHELL_AREA_LABELS[shellNodeId];
  return region === 'dialogs' ? 'Dialogs' : 'Pages';
}

type EditorTreeSnapshot = Pick<
  ReturnType<typeof useConfigStore.getState>,
  'header' | 'footer' | 'leftSidebar' | 'rightSidebar' | 'dialogs' | 'pages'
>;

function resolveEditorRegion(id: string, state: EditorTreeSnapshot): EditorRegion | null {
  if (treeContains(state.header, id)) return 'header';
  if (treeContains(state.footer, id)) return 'footer';
  if (treeContains(state.leftSidebar, id)) return 'leftSidebar';
  if (treeContains(state.rightSidebar, id)) return 'rightSidebar';
  if (state.dialogs.some((dialog) => dialog.id === id || treeContains(dialog.widgets, id))) {
    return 'dialogs';
  }
  if (isFound(findInPages(state.pages, id))) return 'pages';
  return null;
}

function resolveEditorCategoryTitle(
  selectedId: string | null,
  selectedRegion: EditorRegion | null,
  previewAreaId: string,
  state: EditorTreeSnapshot,
): string {
  if (selectedId === EDITOR_NODE_IDS.SETTINGS || selectedId === EDITOR_NODE_IDS.EVENTS) {
    return 'Global Settings';
  }
  if (selectedId === EDITOR_NODE_IDS.PAGES) return 'Pages';
  if (selectedId === EDITOR_NODE_IDS.DIALOGS) return 'Dialogs';

  if (selectedId) {
    const directShellTitle = SHELL_AREA_LABELS[selectedId];
    if (directShellTitle) return directShellTitle;
    // Skip the tree walk when the selector already knew which region it picked from.
    const region = selectedRegion ?? resolveEditorRegion(selectedId, state);
    if (region) return regionLabel(region);
  }

  const previewShellTitle = SHELL_AREA_LABELS[previewAreaId];
  if (previewShellTitle) return previewShellTitle;
  if (state.dialogs.some((dialog) => dialog.id === previewAreaId)) return 'Dialogs';
  return 'Pages';
}

/** Ids of the clicked node and its widget ancestors, innermost first. */
function readPathIds(data: Record<string, unknown>): string[] {
  const pathIds = Array.isArray(data.pathIds)
    ? data.pathIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
    : [];
  if (pathIds.length > 0) return pathIds;
  return typeof data.id === 'string' && data.id.length > 0 ? [data.id] : [];
}

/** The right-clicked node, but only when it is a widget: copying or deleting a
 *  whole page, dialog or shell area stays a tree action. */
function resolveClickedWidget(
  state: ReturnType<typeof useConfigStore.getState>,
  id: string | null,
): { id: string; name: string; kind: NodeKind } | null {
  const resolved = id ? kindForSelectedId(state, id) : null;
  if (!id || (resolved?.kind !== 'container' && resolved?.kind !== 'leaf')) return null;
  const widget = findWidgetEverywhere(state, id);
  return widget ? { id, name: widget.name, kind: resolved.kind } : null;
}

/** Resolves a preview click to a selectable id, plus the region it was found in
 *  (already known here from the same lookup) so callers don't have to re-walk
 *  the tree just to label the selection. */
function resolvePreviewSelectionId(
  candidates: string[],
  state: ReturnType<typeof useConfigStore.getState>,
): { id: string; region: EditorRegion } | null {
  // Innermost candidate wins. The preview already dropped the nodes a component
  // definition draws (a click on one arrives as the instance), so what is left
  // is authored here — including slot content, which renders deeper than the
  // instance node and must select as itself. Ids are per-tree slugs, so they
  // cannot be told apart by looking them up: the marker has to come from the
  // DOM, not from a store lookup.
  for (const id of candidates) {
    const region = resolveEditorRegion(id, state);
    if (region) return { id, region };
  }
  return null;
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function LivePreview({ pageId }: { pageId: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [fitBoxSize, setFitBoxSize] = useState<{ width: number; height: number } | null>(null);
  const initialPageIdRef = useRef(pageId);
  const selectedId = useEditorDomainStore((s) => s.selectedId);
  const selectedIds = useEditorDomainStore((s) => s.selectedIds);
  const selectionAnchorId = useEditorDomainStore((s) => s.selectionAnchorId);
  const selectedRegion = useEditorDomainStore((s) => s.selectedRegion);
  const setSelected = useEditorDomainStore((s) => s.setSelected);
  const pages = useConfigStore((s) => s.pages);
  const header = useConfigStore((s) => s.header);
  const footer = useConfigStore((s) => s.footer);
  const leftSidebar = useConfigStore((s) => s.leftSidebar);
  const rightSidebar = useConfigStore((s) => s.rightSidebar);
  const shell = useConfigStore((s) => s.shell);
  const dialogs = useConfigStore((s) => s.dialogs);
  const globalEvents = useConfigStore((s) => s.globalEvents);
  const loadedPageIds = useConfigStore((s) => s.loadedPageIds);
  const translationLanguages = useTranslationStore((s) => s.languages);
  const translationRows = useTranslationStore((s) => s.translations);
  const draftComponents = useComponentStore((s) => s.draftComponents);
  const components = useComponentStore((s) => s.components);
  const [vpIdx, setVpIdx] = useState(0); // default: Fit panel
  const [previewMode, setPreviewMode] = useState<'config' | 'test'>('config');
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    target: PreviewInsertTarget;
    /** The widget actually under the cursor, when one was hit — Copy and Delete
     *  act on it rather than on the container that would receive a new widget. */
    widget: { id: string; name: string; kind: NodeKind } | null;
  } | null>(null);
  const [selectorTarget, setSelectorTarget] = useState<PreviewInsertTarget | null>(null);
  const [scalePct, setScalePct] = useState(100);
  // Free-typed text for the scaling field, separate from scalePct so partial
  // input (an empty field, "1", "15") isn't clamped/overwritten mid-keystroke.
  // Committed to scalePct on blur/Enter; resynced whenever scalePct changes
  // from elsewhere (buttons, keyboard shortcuts).
  const [scaleInput, setScaleInput] = useState('100');
  // Escape reverts scaleInput then blurs in the same handler, but that blur's
  // onBlur→commit fires before React re-renders with the reverted text, so it
  // would otherwise commit the stale (just-typed, possibly invalid) value.
  // This flag tells the very next commit to no-op instead.
  const skipNextScaleCommitRef = useRef(false);

  const adjustScale = useCallback((action: 'in' | 'out' | 'reset') => {
    if (action === 'reset') {
      setScalePct(100);
      return;
    }
    setScalePct((p) => clampScale(p + (action === 'in' ? SCALE_STEP : -SCALE_STEP)));
  }, []);

  useEffect(() => {
    setScaleInput(String(scalePct));
  }, [scalePct]);

  const commitScaleInput = useCallback(() => {
    if (skipNextScaleCommitRef.current) {
      skipNextScaleCommitRef.current = false;
      return;
    }
    const parsed = Number.parseInt(scaleInput, 10);
    setScalePct(Number.isFinite(parsed) ? clampScale(parsed) : scalePct);
  }, [scaleInput, scalePct]);

  const cancelScaleInput = useCallback(() => {
    skipNextScaleCommitRef.current = true;
    setScaleInput(String(scalePct));
  }, [scalePct]);

  // Repurpose the browser's own zoom shortcuts (which useDisableBrowserZoom
  // blocks from reaching native page zoom) to drive this scaling control instead.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        adjustScale('in');
      } else if (e.key === '-') {
        e.preventDefault();
        adjustScale('out');
      } else if (e.key === '0') {
        e.preventDefault();
        adjustScale('reset');
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [adjustScale]);

  // Tracks the scroller's content-box size so a zoomed-out Fit view can be
  // sized in real pixels (see wrapperStyle below) instead of a CSS percentage —
  // percentage heights inside a zoomed flex child resolve unreliably across
  // engines, especially with a `height: 100%` iframe descendant.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setFitBoxSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const postToPreview = useCallback((message: unknown) => {
    const target = iframeRef.current?.contentWindow;
    if (!target) return;
    target.postMessage(message, TRUSTED_ORIGIN);
  }, []);

  // Zustand mutates these as fresh refs on every change, so identity equality
  // catches every real update without paying for a per-keystroke stringify.
  type PagesSnapshot = {
    pages: unknown;
    header: unknown;
    footer: unknown;
    leftSidebar: unknown;
    rightSidebar: unknown;
    shell: unknown;
    dialogs: unknown;
    globalEvents: unknown;
    loadedPageIds: unknown;
  };
  const lastPagesSnapshotRef = useRef<PagesSnapshot | null>(null);

  // Push all areas into the iframe so tree changes appear immediately.
  // The preview only renders one page at a time; send component content for
  // every loaded page so the preview has it when it navigates among them.
  const syncPages = useCallback(
    (options?: { force?: boolean }) => {
      const s = useConfigStore.getState();
      const snapshot: PagesSnapshot = {
        pages: s.pages,
        header: s.header,
        footer: s.footer,
        leftSidebar: s.leftSidebar,
        rightSidebar: s.rightSidebar,
        shell: s.shell,
        dialogs: s.dialogs,
        globalEvents: s.globalEvents,
        loadedPageIds: s.loadedPageIds,
      };
      const last = lastPagesSnapshotRef.current;
      if (
        !options?.force &&
        last &&
        last.pages === snapshot.pages &&
        last.header === snapshot.header &&
        last.footer === snapshot.footer &&
        last.leftSidebar === snapshot.leftSidebar &&
        last.rightSidebar === snapshot.rightSidebar &&
        last.shell === snapshot.shell &&
        last.dialogs === snapshot.dialogs &&
        last.globalEvents === snapshot.globalEvents &&
        last.loadedPageIds === snapshot.loadedPageIds
      )
        return;
      lastPagesSnapshotRef.current = snapshot;

      const pageContent: Record<string, unknown[]> = {};
      for (const page of flattenPages(s.pages)) {
        if (s.loadedPageIds.has(page.id)) {
          pageContent[page.id] = getPageChildren(page) as unknown[];
        }
      }
      postToPreview({
        type: 'pages_update',
        pages: s.pages,
        header: s.header,
        footer: s.footer,
        leftSidebar: s.leftSidebar,
        rightSidebar: s.rightSidebar,
        shell: s.shell,
        dialogs: s.dialogs,
        globalEvents: s.globalEvents,
        pageContent,
      });
    },
    [postToPreview],
  );

  const syncTranslations = useCallback(() => {
    const s = useTranslationStore.getState();
    postToPreview({
      type: 'translations_update',
      languages: s.languages,
      translations: s.translations,
    });
  }, [postToPreview]);

  const syncComponents = useCallback(() => {
    const s = useComponentStore.getState();
    postToPreview({
      type: 'components_update',
      components: s.components,
      draftComponents: s.draftComponents,
    });
  }, [postToPreview]);

  // Send the current selection into the iframe whenever it changes. `lead` is the row
  // the click landed on (see `clickedLead`), which is the only one the preview should
  // scroll to — a removal sends null so the canvas stays where the user is looking.
  // `null` until the first send: an empty selection still has to be announced once.
  const sentSelectionRef = useRef<string[] | null>(null);
  const syncSelection = useCallback(
    (options?: { full?: boolean }) => {
      const previous = sentSelectionRef.current;
      // `echoSelection` may already have answered this exact selection with the
      // clicked id as lead, and the store change that follows re-runs this effect.
      // Re-sending would overwrite that lead with null, so which message the preview
      // acts on would decide whether it scrolls to the widget.
      if (!options?.full && previous && sameIds(previous, selectedIds)) return;
      const added = previous ? selectedIds.filter((id) => !previous.includes(id)) : selectedIds;
      sentSelectionRef.current = selectedIds;
      // A full resync follows a fresh preview mount, which knows nothing of what was
      // sent before: diffing against the ref would report no lead and leave an
      // off-screen selection off-screen. The lead is the last entry by store invariant.
      const lead = options?.full
        ? (selectedIds[selectedIds.length - 1] ?? null)
        : clickedLead(selectedIds, added, selectionAnchorId);
      postToPreview({ type: 'set_selected', ids: selectedIds, lead });
    },
    [selectedIds, selectionAnchorId, postToPreview],
  );

  /** Re-send the selection the store now holds, with `lead` set to the id the click
   *  landed on — the state change may not re-run `syncSelection` on its own. */
  const echoSelection = useCallback(
    (lead: string) => {
      const ids = useEditorDomainStore.getState().selectedIds;
      sentSelectionRef.current = ids;
      postToPreview({ type: 'set_selected', ids, lead: ids.includes(lead) ? lead : null });
    },
    [postToPreview],
  );

  const syncRoute = useCallback(
    (nextPageId: string, replace = false) => {
      postToPreview({ type: 'navigate_preview', pageId: nextPageId, replace });
    },
    [postToPreview],
  );

  const syncMode = useCallback(() => {
    postToPreview({ type: 'set_mode', mode: previewMode });
  }, [previewMode, postToPreview]);

  // Push pages whenever they change in the parent configStore (including when
  // a page's content is lazily loaded — loadedPageIds changes too).
  useEffect(() => {
    syncPages();
  }, [
    pages,
    header,
    footer,
    leftSidebar,
    rightSidebar,
    shell,
    dialogs,
    globalEvents,
    loadedPageIds,
    syncPages,
  ]);
  useEffect(() => {
    syncSelection();
  }, [syncSelection]);
  useEffect(() => {
    syncRoute(pageId);
  }, [pageId, syncRoute]);
  useEffect(() => {
    syncTranslations();
  }, [translationLanguages, translationRows, syncTranslations]);
  useEffect(() => {
    syncComponents();
  }, [draftComponents, components, syncComponents]);
  useEffect(() => {
    syncMode();
  }, [syncMode]);

  // Push initial state into the iframe on load or when the preview signals ready.
  const syncAll = useCallback(() => {
    syncPages({ force: true });
    syncSelection({ full: true });
    syncRoute(pageId, true);
    syncTranslations();
    syncComponents();
    syncMode();
  }, [pageId, syncPages, syncSelection, syncRoute, syncTranslations, syncComponents, syncMode]);

  // After the iframe finishes loading push both pages and current selection
  const handleLoad = useCallback(() => {
    syncAll();
  }, [syncAll]);

  // Receive component_clicked / preview_ready / preview_location from the preview iframe
  useEffect(() => {
    const handlers: Record<string, (data: Record<string, unknown>) => void> = {
      preview_ready: () => syncAll(),
      preview_zoom: (data) => {
        const action = data.action as 'in' | 'out' | 'reset' | undefined;
        if (action) adjustScale(action);
      },
      preview_location: (data) => {
        const rawPageId = data.pageId as string | undefined;
        if (!rawPageId) return;
        let nextPageId = rawPageId;
        const pageNode = findPageNodeById(useConfigStore.getState().pages, rawPageId);
        if (pageNode && isPageGroup(pageNode)) {
          const firstChild = pageNode.children[0];
          if (firstChild) nextPageId = firstChild.id;
        }
        const store = useEditorDomainStore.getState();
        if (store.previewAreaId !== nextPageId) store.openTab(nextPageId);
      },
      component_clicked: (data) => {
        const candidates = readPathIds(data);
        if (candidates.length === 0) return;
        const state = useConfigStore.getState();
        const resolved = resolvePreviewSelectionId(candidates, state);
        if (resolved) {
          const store = useEditorDomainStore.getState();
          // Ctrl/cmd-click extends, but only between widgets — clicking a page
          // group or a shell area always starts a fresh selection.
          if (data.toggle === true && canExtendWith(store.selectedIds, resolved.id, state)) {
            store.toggleSelected(resolved.id, resolved.region);
          } else {
            setSelected(resolved.id, resolved.region);
          }
          // A click is also an acknowledgement of the selection protocol. Send
          // it back even when Zustand already holds this id, because an iframe
          // route/render transition may have happened without a parent state
          // change that would re-run the selection effect.
          echoSelection(resolved.id);
        }
      },
      preview_context_menu: (data) => {
        const iframe = iframeRef.current;
        if (!iframe) return;
        const state = useConfigStore.getState();
        // Right-click selects what a left-click would, unless the node is already
        // part of the selection — then the whole set survives, so a menu verb acts
        // on everything the canvas shows as selected.
        const resolved = resolvePreviewSelectionId(readPathIds(data), state);
        if (resolved) {
          const store = useEditorDomainStore.getState();
          if (!store.selectedIds.includes(resolved.id)) setSelected(resolved.id, resolved.region);
          echoSelection(resolved.id);
        }
        const target = resolvePreviewInsertTarget(state, resolved?.id ?? null, pageId);
        if (!target) return;
        // Reported coordinates are iframe-viewport pixels; the iframe's own rect
        // already includes the preview scale transform.
        const rect = iframe.getBoundingClientRect();
        const scalePreview = scalePct / 100;
        const x = typeof data.x === 'number' ? data.x : 0;
        const y = typeof data.y === 'number' ? data.y : 0;
        setCtxMenu({
          x: rect.left + x * scalePreview,
          y: rect.top + y * scalePreview,
          target,
          widget: resolveClickedWidget(state, resolved?.id ?? null),
        });
      },
    };

    function handleMsg(event: MessageEvent) {
      if (event.origin !== TRUSTED_ORIGIN) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data;
      if (!data || typeof data.type !== 'string') return;
      handlers[data.type]?.(data);
    }
    window.addEventListener('message', handleMsg);
    return () => window.removeEventListener('message', handleMsg);
  }, [
    adjustScale,
    echoSelection,
    pageId,
    postToPreview,
    scalePct,
    setSelected,
    syncAll,
    syncPages,
    syncSelection,
    syncRoute,
    syncTranslations,
  ]);

  const insertIntoTarget = useCallback(
    (target: PreviewInsertTarget, type: string) => {
      const store = useConfigStore.getState();
      const ids = collectAllIds(store);
      const comp =
        type === 'Container' ? makeDefaultContainer(ids) : makeComponentOfType(type, ids);
      insertComponentInto(store, target.kind, target.nodeId, comp);
      setSelected(comp.id);
    },
    [setSelected],
  );

  const handleMenuAction = useCallback(
    (action: string) => {
      if (!ctxMenu) return;
      const { target, widget } = ctxMenu;
      const sep = action.indexOf(':');
      const verb = sep === -1 ? action : action.slice(0, sep);

      switch (verb) {
        case 'addContainer':
          insertIntoTarget(target, 'Container');
          break;
        case 'openWidgetSelector':
          setSelectorTarget(target);
          break;
        case 'paste':
          void readTreeNodeFromClipboard().then((entry) => {
            if (!entry) return;
            dispatchPaste(projectFromStore(), entry, target.nodeId, target.kind);
          });
          break;
        case 'copy':
        case 'cut': {
          if (!widget) break;
          const source = resolveCopyEntry(projectFromStore(), widget.id, widget.kind);
          if (!source) {
            pasteToast('error', `Nothing to ${verb}`);
            break;
          }
          void copyTreeNode(source, verb === 'cut' ? 'cut' : 'copy');
          if (verb === 'cut') setCut(clipboardNodeIds(source), clipboardKind(source));
          else clearCut();
          break;
        }
        case 'delete': {
          if (!widget) break;
          // Right-clicking a widget outside the selection has already re-pointed it,
          // so this is always what the canvas shows as selected.
          const selectedIds = useEditorDomainStore.getState().selectedIds;
          deleteWidgetsKeepingSelection(verbTargets(selectedIds, widget.id, projectFromStore()));
          break;
        }
      }
    },
    [ctxMenu, insertIntoTarget],
  );

  const vp = VIEWPORTS[vpIdx];
  const isFit = vp.w === 0;
  const scale = scalePct / 100;
  // Fixed device presets: `transform: scale` paints the frame bigger/smaller
  // without changing its layout width, so the iframe still lays out its HMI
  // content at the real device width — like an operator leaning in closer.
  // Fit-and-zoomed-out is different: shrinking a 100%-wide box the same way
  // would leave dead space around it. Instead size the box to the panel's
  // real pixel dimensions divided by the scale, then transform it back down —
  // that reflows the HMI content into the wider effective viewport first, so
  // the zoomed-out result still fills the panel edge-to-edge. Pixels (not a
  // CSS percentage) because percentage heights on a zoomed flex child with a
  // `height:100%` iframe inside resolve unreliably across engines.
  const wrapperStyle: CSSWithVars =
    isFit && scale < 1 && fitBoxSize
      ? {
          width: `${fitBoxSize.width / scale}px`,
          height: `${fitBoxSize.height / scale}px`,
          // Otherwise the flex container's default flex-shrink shrinks this
          // oversized pre-transform box straight back down to fit, before the
          // transform below gets a chance to scale it — the same reason the
          // fixed-device-preset branch sets flex-shrink: 0 in CSS.
          flexShrink: 0,
          transform: `scale(${scale})`,
          transformOrigin: 'top center',
        }
      : {
          ...(isFit ? {} : { '--preview-w': `${vp.w}px`, '--preview-h': `${vp.h}px` }),
          ...(scale !== 1 ? { transform: `scale(${scale})`, transformOrigin: 'top center' } : {}),
        };
  // Dialogs render their own modal chrome (border/shadow) on a plain checkerboard —
  // the device-frame wrapper would double up as an extra frame around them.
  const isDialogPreview = dialogs.some((d) => d.id === pageId);
  const previewTitle = useMemo(
    () =>
      resolveEditorCategoryTitle(selectedId, selectedRegion, pageId, {
        header,
        footer,
        leftSidebar,
        rightSidebar,
        dialogs,
        pages,
      }),
    [selectedId, selectedRegion, pageId, header, footer, leftSidebar, rightSidebar, dialogs, pages],
  );

  return (
    <ConfigWorkspace
      title={previewTitle}
      flush
      className="editor-preview-panel"
      actions={
        <>
          <ViewportSelector vpIdx={vpIdx} onChange={setVpIdx} />

          <span className="editor-preview-toolbar__label">Scaling</span>
          <div
            className="editor-preview-toolbar__seg editor-preview-toolbar__scale cfg-header-control"
            role="group"
            aria-label="Preview scaling"
          >
            <button
              type="button"
              className="editor-preview-toolbar__seg-btn"
              onClick={() => adjustScale('out')}
              disabled={scalePct <= SCALE_MIN}
              title="Decrease scaling"
              aria-label="Decrease scaling"
            >
              <Minus size={16} weight="regular" />
            </button>
            <span className="editor-preview-toolbar__scale-value">
              <input
                type="text"
                inputMode="numeric"
                className="editor-preview-toolbar__scale-input"
                value={scaleInput}
                onChange={(e) => setScaleInput(e.target.value.replace(/[^0-9]/g, ''))}
                onBlur={commitScaleInput}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    commitScaleInput();
                    e.currentTarget.blur();
                  } else if (e.key === 'Escape') {
                    cancelScaleInput();
                    e.currentTarget.blur();
                  }
                }}
                aria-label="Scaling percentage"
              />
              %
            </span>
            <button
              type="button"
              className="editor-preview-toolbar__seg-btn"
              onClick={() => adjustScale('in')}
              disabled={scalePct >= SCALE_MAX}
              title="Increase scaling"
              aria-label="Increase scaling"
            >
              <Plus size={16} weight="regular" />
            </button>
          </div>

          <span className="editor-preview-toolbar__label">Mode</span>
          <div
            className="editor-preview-toolbar__seg cfg-header-control"
            role="group"
            aria-label="Preview mode"
          >
            <button
              type="button"
              className={`editor-preview-toolbar__seg-btn${
                previewMode === 'config' ? ' editor-preview-toolbar__seg-btn--active' : ''
              }`}
              onClick={() => setPreviewMode('config')}
              aria-pressed={previewMode === 'config'}
              title="Config mode — interactions disabled"
            >
              <PencilSimple size={16} weight="regular" />
            </button>
            <button
              type="button"
              className={`editor-preview-toolbar__seg-btn${
                previewMode === 'test' ? ' editor-preview-toolbar__seg-btn--active' : ''
              }`}
              onClick={() => setPreviewMode('test')}
              aria-pressed={previewMode === 'test'}
              title="Test mode — actions and page switching enabled"
            >
              <Play size={16} weight="regular" />
            </button>
          </div>
        </>
      }
    >
      <TabBar />

      <div className="editor-preview-scroller" ref={scrollerRef}>
        <div
          className={`editor-preview-wrapper${isFit ? ' editor-preview-wrapper--fit' : ''}${
            isDialogPreview ? ' editor-preview-wrapper--frameless' : ''
          }`}
          style={wrapperStyle}
        >
          <iframe
            ref={iframeRef}
            src={withBase(`/preview/${initialPageIdRef.current}`)}
            className="editor-preview-iframe"
            title="HMI Preview"
            onLoad={handleLoad}
          />
        </div>
      </div>

      {ctxMenu && (
        <PreviewContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          target={ctxMenu.target}
          widget={ctxMenu.widget}
          onClose={() => setCtxMenu(null)}
          onAction={handleMenuAction}
        />
      )}

      {selectorTarget && (
        <WidgetSelector
          contextName={selectorTarget.name}
          onClose={() => setSelectorTarget(null)}
          onInsert={(type) => {
            insertIntoTarget(selectorTarget, type);
            setSelectorTarget(null);
          }}
        />
      )}
    </ConfigWorkspace>
  );
}
