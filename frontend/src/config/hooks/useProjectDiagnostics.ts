/**
 * Project-wide build diagnostics.
 *
 * Two sources feed one picture:
 * - `GET /api/config/validate` sweeps every artifact **on disk** — pages never
 *   opened this session, components, translations, custom-widget builds. It
 *   runs whenever the project goes clean, so it always describes the last save.
 * - `usePanelDiagnostics` holds the realtime verdict for the one artifact a
 *   panel currently has open, unsaved edits included.
 *
 * The merge replaces the sweep's rows for that one artifact with the live ones,
 * so the counts and tree marks stay truthful for whatever is being edited while
 * everything else keeps its last-save answer (`stale` says so).
 *
 * `useProjectDiagnosticsSweep` owns the fetch and must be mounted exactly once
 * — `SaveWarningsPill` does that, and it lives in the always-mounted header.
 */
import { create } from 'zustand';
import { useEffect, useMemo, useRef } from 'react';
import { apiJson } from '@shared/utils/api';
import { useProjectStore } from '@shared/store/projectStore';
import { useConfigStore } from '@shared/store/configStore';
import { findComponentById } from '@shared/utils/widgetTree';
import { EDITOR_NODE_IDS } from '@shared/constants/editorSentinels';
import type { PageGroupConfig, WidgetConfig } from '@shared/types/config';
import { isPageGroup } from '@shared/utils/pageTree';
import {
  diagnosticArtifactKey,
  usePanelDiagnosticsStore,
  type Diagnostic,
} from './usePanelDiagnostics';

export type DiagnosticSeverity = 'error' | 'warning';

interface ProjectDiagnosticsState {
  /** Last completed sweep, or null until the first one lands. */
  swept: Diagnostic[] | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

let sweepId = 0;

export const useProjectDiagnosticsStore = create<ProjectDiagnosticsState>((set) => ({
  swept: null,
  loading: false,
  refresh: async () => {
    const id = ++sweepId;
    set({ loading: true });
    try {
      const res = await apiJson<{ diagnostics?: Diagnostic[] }>('/api/config/validate');
      // A newer sweep started while this one was in flight — drop the stale answer.
      if (id !== sweepId) return;
      set({ swept: res?.diagnostics ?? [], loading: false });
    } catch {
      if (id !== sweepId) return;
      set({ swept: [], loading: false });
    }
  },
}));

/** Re-sweeps the project whenever it settles — once on mount, then after every
 *  successful save. Mount once. */
export function useProjectDiagnosticsSweep(): void {
  const dirty = useProjectStore((s) => s.dirty);
  // The mount sweep runs even on a dirty project: it is the only thing the
  // pill can show for artifacts no panel has open, and waiting for the first
  // save would leave it blank.
  const sweptOnce = useRef(false);
  useEffect(() => {
    if (dirty && sweptOnce.current) return;
    sweptOnce.current = true;
    void useProjectDiagnosticsStore.getState().refresh();
  }, [dirty]);
}

function worse(
  current: DiagnosticSeverity | undefined,
  next: DiagnosticSeverity,
): DiagnosticSeverity {
  return current === 'error' || next === 'error' ? 'error' : 'warning';
}

function mark(map: Map<string, DiagnosticSeverity>, key: string, severity: DiagnosticSeverity) {
  map.set(key, worse(map.get(key), severity));
}

interface MergedDiagnostics {
  all: Diagnostic[];
  errorCount: number;
  /** Worst severity per widget id — the widget's own rows only, no rollup. */
  byWidget: Map<string, DiagnosticSeverity>;
  /** Worst severity per `kind:id` artifact, covering everything inside it. */
  byArtifact: Map<string, DiagnosticSeverity>;
  /** Worst severity per artifact *kind*, for the tree's collapsed Pages /
   *  Dialogs section rows — with those shut, nothing else would show. */
  byKind: Map<string, DiagnosticSeverity>;
}

// Every tree row asks for the same derivation, so it is computed once per
// distinct input triple and shared by reference — otherwise each of the
// hundreds of rows would rebuild the maps on every render and invalidate its
// own downstream memos.
let mergeCache: {
  swept: Diagnostic[] | null;
  live: Diagnostic[];
  liveKey: string | null;
  value: MergedDiagnostics;
} | null = null;

function mergeDiagnostics(
  swept: Diagnostic[] | null,
  live: Diagnostic[],
  liveKey: string | null,
): MergedDiagnostics {
  if (
    mergeCache &&
    mergeCache.swept === swept &&
    mergeCache.live === live &&
    mergeCache.liveKey === liveKey
  ) {
    return mergeCache.value;
  }
  const base = swept ?? [];
  const all = liveKey
    ? [
        ...base.filter((d) => diagnosticArtifactKey(d.artifactKind, d.artifactId) !== liveKey),
        ...live,
      ]
    : base;

  const byWidget = new Map<string, DiagnosticSeverity>();
  const byArtifact = new Map<string, DiagnosticSeverity>();
  const byKind = new Map<string, DiagnosticSeverity>();
  let errorCount = 0;
  for (const d of all) {
    if (d.severity === 'error') errorCount += 1;
    if (d.widgetId) mark(byWidget, d.widgetId, d.severity);
    mark(byArtifact, diagnosticArtifactKey(d.artifactKind, d.artifactId), d.severity);
    mark(byKind, d.artifactKind, d.severity);
  }

  const value: MergedDiagnostics = { all, errorCount, byWidget, byArtifact, byKind };
  mergeCache = { swept, live, liveKey, value };
  return value;
}

function useMergedDiagnostics(): MergedDiagnostics {
  const swept = useProjectDiagnosticsStore((s) => s.swept);
  const live = usePanelDiagnosticsStore((s) => s.all);
  const liveKey = usePanelDiagnosticsStore((s) => s.artifactKey);
  return mergeDiagnostics(swept, live, liveKey);
}

/** Worst severity per widget id, for tree rows. Stable by reference between
 *  diagnostic updates, so callers can memo their subtree walks on it. */
export function useWidgetSeverities(): Map<string, DiagnosticSeverity> {
  return useMergedDiagnostics().byWidget;
}

/** Worst severity anywhere inside one artifact, for its page/dialog tree row. */
export function useArtifactSeverity(
  kind: string,
  id: string | null,
): DiagnosticSeverity | undefined {
  return useMergedDiagnostics().byArtifact.get(diagnosticArtifactKey(kind, id));
}

/** Worst severity per `kind:id` artifact — for rows that roll several up. */
export function useArtifactSeverities(): Map<string, DiagnosticSeverity> {
  return useMergedDiagnostics().byArtifact;
}

/** Worst severity across every page nested in a group, at any depth. A
 *  collapsed group row is otherwise the only thing standing between the user
 *  and a page they can't see. */
export function pageGroupSeverity(
  group: PageGroupConfig,
  byArtifact: Map<string, DiagnosticSeverity>,
): DiagnosticSeverity | undefined {
  if (byArtifact.size === 0) return undefined;
  let severity: DiagnosticSeverity | undefined;
  for (const child of group.children) {
    const childSeverity = isPageGroup(child)
      ? pageGroupSeverity(child, byArtifact)
      : byArtifact.get(diagnosticArtifactKey('page', child.id));
    if (childSeverity) severity = worse(severity, childSeverity);
    if (severity === 'error') return 'error';
  }
  return severity;
}

/** Tooltip wording shared by every rolled-up tree mark. */
export function containsSeverityTitle(severity: DiagnosticSeverity): string {
  return `Contains ${severity === 'error' ? 'an error' : 'a warning'}`;
}

/** Worst severity on `comp` or anywhere below it — a collapsed container still
 *  shows that something inside it is broken. */
export function subtreeSeverity(
  comp: WidgetConfig,
  byWidget: Map<string, DiagnosticSeverity>,
): DiagnosticSeverity | undefined {
  if (byWidget.size === 0) return undefined;
  let severity = byWidget.get(comp.id);
  if (severity === 'error') return 'error';
  for (const child of comp.children ?? []) {
    const childSeverity = subtreeSeverity(child, byWidget);
    if (childSeverity) severity = worse(severity, childSeverity);
    if (severity === 'error') return 'error';
  }
  return severity;
}

const SHELL_AREA_NODE_IDS: ReadonlyArray<[string, keyof ShellAreas]> = [
  [EDITOR_NODE_IDS.HEADER, 'header'],
  [EDITOR_NODE_IDS.FOOTER, 'footer'],
  [EDITOR_NODE_IDS.LEFT_SIDEBAR, 'leftSidebar'],
  [EDITOR_NODE_IDS.RIGHT_SIDEBAR, 'rightSidebar'],
];

interface ShellAreas {
  header: WidgetConfig[];
  footer: WidgetConfig[];
  leftSidebar: WidgetConfig[];
  rightSidebar: WidgetConfig[];
}

/**
 * Which shell-area tree node a `shell` diagnostic belongs under: either the
 * area holding the offending widget, or — for region settings, which own no
 * widget — the reserved node id the backend already stamped as the owner.
 * Null when neither applies (the finding stays list-only).
 */
export function shellAreaNodeIdFor(widgetId: string | null, areas: ShellAreas): string | null {
  if (!widgetId) return null;
  for (const [nodeId, area] of SHELL_AREA_NODE_IDS) {
    if (widgetId === nodeId) return nodeId;
    if (findComponentById(areas[area], widgetId)) return nodeId;
  }
  return null;
}

export interface DiagnosticIndex extends MergedDiagnostics {
  warningCount: number;
  /** Worst severity per shell-area tree node id (`__header__`, …). */
  byShellArea: Map<string, DiagnosticSeverity>;
  /** No sweep has completed yet — counts are not yet meaningful. */
  pending: boolean;
  /** Unsaved edits exist, so every artifact but the open one is described by
   *  the last save rather than by what is on screen. */
  stale: boolean;
}

/** The full picture: counts, artifact rollups and shell-area rollups.
 *  Subscribes to the shell widget arrays, so prefer `useWidgetSeverities` in
 *  rows that only need a per-widget mark. */
export function useDiagnosticIndex(): DiagnosticIndex {
  const merged = useMergedDiagnostics();
  const swept = useProjectDiagnosticsStore((s) => s.swept);
  const dirty = useProjectStore((s) => s.dirty);
  const header = useConfigStore((s) => s.header);
  const footer = useConfigStore((s) => s.footer);
  const leftSidebar = useConfigStore((s) => s.leftSidebar);
  const rightSidebar = useConfigStore((s) => s.rightSidebar);

  return useMemo(() => {
    const areas = { header, footer, leftSidebar, rightSidebar };
    const byShellArea = new Map<string, DiagnosticSeverity>();
    for (const d of merged.all) {
      if (d.artifactKind !== 'shell') continue;
      const nodeId = shellAreaNodeIdFor(d.widgetId, areas);
      if (nodeId) mark(byShellArea, nodeId, d.severity);
    }
    return {
      ...merged,
      warningCount: merged.all.length - merged.errorCount,
      byShellArea,
      pending: swept === null,
      stale: dirty,
    };
  }, [merged, swept, dirty, header, footer, leftSidebar, rightSidebar]);
}
