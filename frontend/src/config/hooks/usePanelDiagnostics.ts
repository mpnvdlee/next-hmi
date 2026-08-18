/**
 * Realtime build diagnostics for the property panel.
 *
 * The backend (`core/validation/structure.py`) is the single source of
 * validation truth — this hook only fetches its verdict and paints it. Call
 * `usePanelDiagnostics` once, near the top of whichever panel currently owns
 * the open artifact (page/dialog/shell/globalEvents/component), passing a
 * *memoized* `DiagnosticsArtifact` (stable by reference unless the draft
 * actually changed — the effect depends on it by identity, not deep-equality,
 * so an unmemoized literal would re-fetch on every render). `SchemaFieldRow`
 * then reads the result via `useFieldDiagnostic(widgetId, fieldPath)`,
 * independent of which panel populated it.
 */
import { create } from 'zustand';
import { useEffect, useMemo, useRef } from 'react';
import { apiJson } from '@shared/utils/api';

type DiagnosticSeverity = 'error' | 'warning';

export interface Diagnostic {
  artifactId: string | null;
  artifactKind: string;
  /** Exact JSON pointer to the diagnosed value or expression source. */
  sourcePath?: string;
  widgetId: string | null;
  propKey: string | null;
  /** Property-relative structural path. Older servers may omit it, in which
   *  case consumers fall back to the top-level `propKey`. */
  fieldPath?: string[];
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  breadcrumb: string;
  nested: boolean;
}

type ValidateKind = 'page' | 'dialog' | 'shell' | 'globalEvents' | 'component';

export interface DiagnosticsArtifact {
  kind: ValidateKind;
  /** Artifact identity, matching the `artifactId` the backend stamps on its
   *  rows. Lets the project-wide sweep swap its saved-on-disk rows for this
   *  live verdict — see `useProjectDiagnostics`. */
  id: string | null;
  // Whatever page/dialog/component config object the artifact's editor
  // panel already holds in the store — validated as posted, unsaved edits
  // included.
  draft: object;
}

/** Identity shared by the realtime endpoint and the project sweep, so rows
 *  from the two sources can be matched up. */
export function diagnosticArtifactKey(kind: string, id: string | null | undefined): string {
  return `${kind}:${id ?? ''}`;
}

interface FieldDiagnosticSummary {
  level: DiagnosticSeverity;
  message: string;
  /** True when every diagnostic for this field targets a nested sub-slot
   *  (e.g. an `$if` condition) rather than the field's own top-level value —
   *  FieldGroup renders those as a badge dot only, no text underline. */
  nested: boolean;
}

export function summarizeFieldDiagnostics(
  diagnostics: readonly Diagnostic[] | undefined,
  requestedPath: readonly string[],
): FieldDiagnosticSummary | undefined {
  if (!diagnostics || diagnostics.length === 0 || requestedPath.length === 0) return undefined;
  const pathFor = (diagnostic: Diagnostic) =>
    diagnostic.fieldPath ?? (diagnostic.propKey ? [diagnostic.propKey] : []);
  const matches = diagnostics.filter((diagnostic) => {
    const diagnosticPath = pathFor(diagnostic);
    return (
      diagnosticPath.length >= requestedPath.length &&
      requestedPath.every((segment, index) => diagnosticPath[index] === segment)
    );
  });
  if (matches.length === 0) return undefined;
  const level: DiagnosticSeverity = matches.some((diagnostic) => diagnostic.severity === 'error')
    ? 'error'
    : 'warning';
  const message = matches.map((diagnostic) => diagnostic.message).join(' · ');
  // Ancestor expression cards get a dot; the exact owning card gets the full
  // text treatment. This lets a path such as
  // title/$if/condition/$compare/left mark Title → Comparison → This value.
  const nested = matches.every((diagnostic) => pathFor(diagnostic).length > requestedPath.length);
  return { level, message, nested };
}

const EMPTY_DIAGNOSTICS: Diagnostic[] = [];

interface PanelDiagnosticsState {
  byWidget: Map<string, Diagnostic[]>;
  /** Every diagnostic from the last realtime verdict, widget-owned or not. */
  all: Diagnostic[];
  /** Findings that belong to the artifact as a whole rather than to any field
   *  — a malformed `sections` map, an invalid page id. No badge can show these,
   *  so the panel banners them instead (see `PanelDiagnosticsBanner`). */
  unowned: Diagnostic[];
  /** Which artifact `all` describes, or null when nothing is loaded. */
  artifactKey: string | null;
  setDiagnostics: (diagnostics: Diagnostic[], artifactKey: string) => void;
  clear: () => void;
}

export const usePanelDiagnosticsStore = create<PanelDiagnosticsState>((set) => ({
  byWidget: new Map(),
  all: EMPTY_DIAGNOSTICS,
  unowned: EMPTY_DIAGNOSTICS,
  artifactKey: null,
  setDiagnostics: (diagnostics, artifactKey) => {
    const byWidget = new Map<string, Diagnostic[]>();
    const unowned: Diagnostic[] = [];
    for (const d of diagnostics) {
      if (!d.widgetId) {
        unowned.push(d);
        continue;
      }
      const list = byWidget.get(d.widgetId);
      if (list) list.push(d);
      else byWidget.set(d.widgetId, [d]);
    }
    set({
      byWidget,
      all: diagnostics,
      // Keep the shared empty array when there are none, so the banner's
      // subscription doesn't re-render on every unrelated revalidation.
      unowned: unowned.length > 0 ? unowned : EMPTY_DIAGNOSTICS,
      artifactKey,
    });
  },
  clear: () =>
    set({
      byWidget: new Map(),
      all: EMPTY_DIAGNOSTICS,
      unowned: EMPTY_DIAGNOSTICS,
      artifactKey: null,
    }),
}));

/** Findings for the open artifact that no field can badge. */
export function useUnownedDiagnostics(): Diagnostic[] {
  return usePanelDiagnosticsStore((s) => s.unowned);
}

const DEBOUNCE_MS = 200;

export function usePanelDiagnostics(artifact: DiagnosticsArtifact | null): void {
  const requestIdRef = useRef(0);

  // The owning panel going away takes its verdict with it. Clearing in the
  // fetch effect's cleanup instead would flash the marks away between every
  // debounce; this only fires on unmount, so a panel that mounts next (the
  // components view, say) can't paint the previous artifact's findings.
  useEffect(() => () => usePanelDiagnosticsStore.getState().clear(), []);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    if (!artifact) {
      usePanelDiagnosticsStore.getState().clear();
      return;
    }
    const timer = setTimeout(() => {
      apiJson<{ diagnostics: Diagnostic[] }>('/api/config/validate', {
        method: 'POST',
        body: { kind: artifact.kind, draft: artifact.draft },
      })
        .then((res) => {
          // A newer edit superseded this in-flight request — drop the stale response.
          if (requestIdRef.current !== requestId) return;
          usePanelDiagnosticsStore
            .getState()
            .setDiagnostics(
              res?.diagnostics ?? [],
              diagnosticArtifactKey(artifact.kind, artifact.id),
            );
        })
        .catch(() => {
          // Backend unreachable — leave existing marks in place rather than
          // flashing them away; the next successful debounce refreshes them.
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      requestIdRef.current = requestId + 1;
    };
  }, [artifact]);
}

export function useFieldDiagnostic(
  widgetId: string | null | undefined,
  fieldPath: string | readonly string[] | null | undefined,
): FieldDiagnosticSummary | undefined {
  // Select the raw array (a stable reference between store updates — only
  // `setDiagnostics`/`clear` ever allocate a new one) rather than building
  // the summary object inline: a selector under `useSyncExternalStore` that
  // returns a fresh object literal on every call — even when nothing
  // changed — makes React 18 treat the snapshot as unstable and re-render in
  // a loop. Deriving the summary in a separate `useMemo` keyed off the
  // stable array sidesteps that entirely.
  // A drawer suffix is added to PanelScopeContext only to isolate expand-state
  // keys; diagnostics still belong to the original widget.
  const diagnosticWidgetId = widgetId?.split('::drawer', 1)[0];
  const list = usePanelDiagnosticsStore((s) =>
    diagnosticWidgetId ? s.byWidget.get(diagnosticWidgetId) : undefined,
  );
  const requestedPath =
    typeof fieldPath === 'string' ? [fieldPath] : fieldPath ? [...fieldPath] : [];
  const pathKey = requestedPath.join('\u001f');
  return useMemo<FieldDiagnosticSummary | undefined>(() => {
    return summarizeFieldDiagnostics(list, requestedPath);
    // `requestedPath` is commonly rebuilt by ParentPathContext each render;
    // its stable scalar key avoids invalidating the memo for equal paths.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, pathKey]);
}
