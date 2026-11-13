/**
 * Recursively renders a component tree node from `config.json`.
 *
 * - Looks up the type in `widgetRegistry`.
 * - Passes `properties` and `layout` as props.
 * - Renders children recursively so Container components receive them.
 * - Falls back to `.hmi-unknown-widget` for unrecognised types.
 *
 * Binding-unavailable overlay:
 * - A component whose VariableBinding(s) cannot be resolved is covered by a
 *   marker: red cross for a binding that is wrong (unknown variable, wrong
 *   type), amber for one that is only without data — the datasource is down,
 *   or no value has ever arrived for it.
 * - The amber ones wait for the surrounding `DataSettleGate`: a page renders
 *   before its variables land, so nothing is marked until that load is over.
 *
 * Widget wrapper, in the runtime and the editor preview alike:
 * - Wraps each component in `<div data-widget-id="..." className="hmi-preview-node">`.
 * - CSS sets `display: contents` on .hmi-preview-node so layout is unaffected.
 * - A Repeater copy past the first carries the template's ids too.
 *
 * Preview mode (set by PreviewContext):
 * - The PreviewView postMessage bridge targets [data-widget-id] to apply
 *   `hmi-preview-node--selected` to the wrapper.
 * - A click on a Repeater copy selects the template, and `--ghost` dims it.
 * - `data-widget-source="definition"` marks what a component definition draws.
 */

import './WidgetRenderer.css';
import { Component, memo, useContext, useMemo, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode, ErrorInfo } from 'react';
import type { WidgetConfig, LayoutConfig } from '@shared/types/config';
import { useConfigStore } from '@shared/store/configStore';
import { useComponentStore } from '@shared/store/componentStore';
import {
  widgetRegistry,
  isContainerHostType,
  isProjectWidgetType,
  placesOwnChildren,
  readsChildProperties,
} from '../registry/widgetRegistry';
import { useHmiStore } from '../store/hmiStore';
import { useHmiScope } from '../context/HmiScopeContext';
import { executeWidgetActions } from '../utils/widgetActions';
import { PreviewContext } from '@shared/context/PreviewContext';
import { DefinitionScopeContext } from '../context/DefinitionScopeContext';
import { useRepeatScope } from '../context/RepeatScopeContext';
import { useInputScope } from '../context/InputScopeContext';
import {
  ALL_STORES,
  storesReadBy,
  useEvalContext,
  WidgetStoresContext,
} from '../hooks/useEvalContext';
import { useBindingStatus } from '../utils/bindingValidation';
import { useBoundIndexes, useScopedProperties } from '../hooks/useResolvedProperties';
import { useLiveKeys, useLiveScalars } from '../hooks/useLiveScalars';
import { useTimeTick } from '../hooks/useTimeTick';
import { useHttpTick } from '../hooks/useHttpTick';
import { usesTime } from '../utils/usesTime';
import { usesHttp } from '../utils/usesHttp';
import {
  getPropBoolean,
  layoutHasPropertySource,
  useResolvedLayout,
  selfFlexChildStyle,
} from './layoutUtils';
import { resolveComponentPropValue } from '../utils/componentPropResolution';

// ── Per-component error boundary ──────────────────────────────────────────────

interface EBProps {
  id: string;
  type: string;
  resetProps: unknown;
  children: ReactNode;
}
interface EBState {
  error: Error | null;
  retryCount: number;
  prevResetProps: unknown;
}

class WidgetErrorBoundary extends Component<EBProps, EBState> {
  private _retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: EBProps) {
    super(props);
    this.state = { error: null, retryCount: 0, prevResetProps: props.resetProps };
  }

  static getDerivedStateFromProps(props: EBProps, state: EBState): Partial<EBState> | null {
    if (props.resetProps !== state.prevResetProps) {
      // Properties changed — reset error and retry counter
      return { error: null, retryCount: 0, prevResetProps: props.resetProps };
    }
    return null;
  }

  static getDerivedStateFromError(error: Error): Partial<EBState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[NEXTHMI] Component "${this.props.type}" (id: ${this.props.id}) crashed:\n`,
      error,
      '\nComponent stack:',
      info.componentStack,
    );
    // Auto-retry for transient errors (e.g. binding change before data arrives).
    // Give up after 3 attempts so a permanent error doesn't loop forever.
    if (this.state.retryCount < 3) {
      if (this._retryTimer) clearTimeout(this._retryTimer);
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null;
        this.setState((s) => ({ error: null, retryCount: s.retryCount + 1 }));
      }, 100);
    }
  }

  componentWillUnmount() {
    if (this._retryTimer) clearTimeout(this._retryTimer);
  }

  render() {
    if (this.state.error && this.state.retryCount >= 3) {
      return (
        <div className="hmi-widget-error" title={this.state.error.message}>
          ⚠ {this.props.type}
        </div>
      );
    }
    if (this.state.error) {
      // Retrying — render nothing while waiting for the auto-retry timer
      return null;
    }
    return this.props.children;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const LOCKED_MESSAGE = 'Interaction not permitted';

/**
 * Build a flex-child style for the binding-unavailable wrapper.
 * The wrapper takes over the layout role normally played by .hmi-component,
 * so the component inside isn't a direct flex/grid child of the page — but the
 * component itself still renders inside it and still applies its own
 * `width`/`height` from the same `layout`, so the wrapper takes only the
 * flex-child fields (`selfFlexChildStyle`), never `width`/`height` — taking
 * both would size the wrapper and the widget inside it independently, and a
 * percentage width on the widget would overflow a wrapper sized by the same
 * percentage of a *different* box (its own parent, not the widget's).
 */
function wrapperStyle(layout?: LayoutConfig): CSSProperties {
  return { position: 'relative', ...selfFlexChildStyle(layout) };
}

// ── Component ─────────────────────────────────────────────────────────────────

function WidgetRendererImpl({ node }: { node: WidgetConfig }) {
  const isPreview = useContext(PreviewContext);
  const fromDefinition = useContext(DefinitionScopeContext);
  const ghost = useRepeatScope()?.ghost === true;
  // A component instance's registry entry is rewritten when a definition
  // changes (AppInner's listener, run inside the same setState), and the memo
  // below would otherwise keep judging the instance against the old schema.
  useComponentStore((s) => (node.type.startsWith('$component:') ? s.components : null));
  const entry = widgetRegistry[node.type];

  // Resolve translation references in properties ({ "$loc": "key" }).
  const scopedProperties = useScopedProperties(node.properties);

  // The stores this widget's eval context follows (`useEvalContext`): the
  // sources of everything it evaluates, so an alarm update or a published
  // export re-renders only the widgets that read one. The layout counts as
  // `useResolvedLayout` evaluates it, each `$componentProp` swapped for its
  // input. A host that reads its children's properties (`readsChildProperties`)
  // evaluates their raw ones too, where a `$componentProp` reads any input of
  // the scope at run time; every other host leaves its children to their own
  // renderers, so their stores stay theirs. A project's widget follows every
  // store: the SDK hands its code the resolvers.
  const childConfigs = isContainerHostType(node.type) ? node.children : undefined;
  const readChildren = childConfigs && readsChildProperties(node.type) ? childConfigs : undefined;
  const inputScopeProps = useInputScope()?.properties;
  const scopedLayout = useMemo(
    () => resolveComponentPropValue(node.layout, inputScopeProps) as LayoutConfig | undefined,
    [node.layout, inputScopeProps],
  );
  const stores = isProjectWidgetType(node.type)
    ? ALL_STORES
    : storesReadBy(
        scopedProperties,
        scopedLayout,
        // Each child's own object, not a new array, so its analysis is cached.
        ...(readChildren?.map((child) => child.properties) ?? []),
        readChildren && inputScopeProps,
      );
  // Built once and shared by every read below; each build is a dozen store
  // subscriptions, most of what a widget render used to cost.
  const evalCtx = useEvalContext(stores);
  // Properties and layout alike: each bound index resolved, each member of a
  // struct-array element bound to its own leaf.
  const resolvedProperties = useBoundIndexes(scopedProperties, evalCtx);
  const resolvedLayout = useBoundIndexes(scopedLayout, evalCtx);

  // A `$var` here re-renders this widget through `useLiveScalars` below.
  const isVisible = getPropBoolean(resolvedProperties, 'visible', true, evalCtx);
  const isInteractable = getPropBoolean(resolvedProperties, 'interactable', true, evalCtx);

  // Status is read from the *resolved* properties: a widget inside a component
  // definition binds through `$componentProp`, which only becomes the real
  // `$var` here. Reading the raw node instead left every such widget — most of
  // a component-built page — with no bindings to check and so never marked.
  const bindingStatus = useBindingStatus(resolvedProperties, entry?.schema ?? {}, evalCtx);

  // Granular live-value subscription: re-render this widget only when a `$var`
  // it actually references ticks. `resolvedProperties` already has any parent
  // `$componentProp` substituted to the real `$var`, so nested/component-prop
  // bindings are covered. Layout `$var` is handled by `useResolvedLayout`.
  useLiveScalars(useLiveKeys(resolvedProperties));

  // Granular `$time` subscription: only widgets that actually reference `$time`
  // re-render on the one-second tick (the rest stay idle). Replaces the blunt
  // view-level `useSecondTick`, which re-rendered every mounted widget per second.
  useTimeTick(usesTime(resolvedProperties) || usesTime(node.layout));

  // Same idea for `$http`: only widgets that reference an HTTP source re-render
  // when a response lands or a poll refreshes.
  useHttpTick(usesHttp(resolvedProperties) || usesHttp(node.layout));

  // Lock-denied flash: tracks click position within the lock overlay
  const [lockFlash, setLockFlash] = useState<{ x: number; y: number } | null>(null);
  const lockedFeedback = useConfigStore((s) => s.shell.lockedFeedback ?? 'flash');
  const scope = useHmiScope();

  // ── Visibility gate ───────────────────────────────────────────────────────
  // All hooks are called above; early return is safe here. `visible` /
  // `interactable` are boolean properties that may hold any expression source
  // (static bool, `$userGroups`, `$var`, `$if`, …); default to true when unset.
  if (!isVisible) {
    return null;
  }

  function handleLockedClick(e: MouseEvent<HTMLDivElement>) {
    // Runs in every feedback mode, so a project can answer a locked press with
    // its own login dialog instead of (or on top of) the built-in feedback.
    executeWidgetActions(useConfigStore.getState().globalEvents.onInteractionDenied, { scope });
    if (lockedFeedback === 'none') return;
    if (lockedFeedback === 'toast') {
      // A fixed id per widget: hammering a locked control re-uses the toast
      // already on screen instead of stacking one per click.
      const toastId = `locked-${node.id}`;
      const { pendingToasts, showToast } = useHmiStore.getState();
      if (!pendingToasts.some((t) => t.id === toastId)) {
        showToast({
          id: toastId,
          message: LOCKED_MESSAGE,
          severity: 'warning',
          discard: 'auto',
          duration: 4000,
        });
      }
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    setLockFlash({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setTimeout(() => setLockFlash(null), 700);
  }

  if (!entry) {
    return <div className="hmi-unknown-widget">{node.type}</div>;
  }

  const Comp = entry.component;

  // A component instance places its children itself, per slot, from
  // `childConfigs` — it never renders `children`. Building them anyway would
  // mint a fresh array of elements every render and defeat the memo on
  // ComponentRenderer, re-rendering the whole definition subtree on any
  // unrelated tick that reaches this node.
  const children = placesOwnChildren(node.type)
    ? undefined
    : node.children?.map((child) => <WidgetRenderer key={child.id} node={child} />);

  // Build the rendered subtree from a layout whose property sources are
  // already resolved — each widget reads its own `widthMode`/`heightMode`
  // straight off it, and `hmi.css`'s flow-translation block (fed by
  // `selfLayoutStyle`) routes them against whichever axis the parent says is
  // main, off that parent's own `data-flow-direction`/`data-flow-align`.
  const buildContent = (layout: LayoutConfig | undefined): ReactNode => {
    const comp = (
      <Comp
        id={node.id}
        name={node.name}
        properties={resolvedProperties}
        layout={layout}
        childConfigs={childConfigs}
      >
        {children}
      </Comp>
    );

    // When a binding is unavailable, wrap with a positioned container + overlay
    const content =
      bindingStatus !== 'ok' ? (
        <div className="hmi-binding-wrapper" style={wrapperStyle(layout)}>
          {comp}
          <div className={`hmi-binding-overlay hmi-binding-overlay--${bindingStatus}`}>
            <span className="hmi-binding-overlay__icon" aria-hidden="true" />
          </div>
        </div>
      ) : !isInteractable ? (
        <div
          className="hmi-lock-wrapper"
          style={wrapperStyle(layout)}
          title={lockedFeedback === 'none' ? undefined : LOCKED_MESSAGE}
          role="group"
          aria-disabled="true"
        >
          {/* The overlay stops the pointer; `inert` stops Tab, Enter and Space,
              which reach the widget underneath straight past it. */}
          <div className="hmi-lock-content" inert>
            {comp}
          </div>
          <div className="hmi-lock-overlay" onClick={handleLockedClick} aria-hidden="true">
            {lockFlash && (
              <span
                className="hmi-lock-flash"
                style={{ left: lockFlash.x, top: lockFlash.y } as CSSProperties}
                aria-hidden="true"
              />
            )}
          </div>
        </div>
      ) : (
        comp
      );

    // The runtime gets the same wrapper as the editor preview, so a test or a
    // script can find a widget by its id and both draw the same DOM.
    return (
      <div
        data-widget-id={node.id}
        data-widget-type={node.type}
        data-widget-source={isPreview && fromDefinition ? 'definition' : undefined}
        className={
          isPreview && ghost ? 'hmi-preview-node hmi-preview-node--ghost' : 'hmi-preview-node'
        }
      >
        {content}
      </div>
    );
  };

  // Only nodes with expression-bound layout subscribe to live values (via the
  // child boundary); static-layout nodes render directly without that cost.
  const inner = layoutHasPropertySource(node.layout) ? (
    <ResolvedLayoutContent layout={resolvedLayout} render={buildContent} />
  ) : (
    buildContent(node.layout)
  );

  return (
    <WidgetErrorBoundary id={node.id} type={node.type} resetProps={node.properties}>
      <WidgetStoresContext.Provider value={stores}>{inner}</WidgetStoresContext.Provider>
    </WidgetErrorBoundary>
  );
}

// Memoised on `node`: a parent that re-renders — its own `$var` ticked, a
// Repeater rebuilt its copies for one changed element — hands its children the
// same nodes, and each child already re-renders on its own variables, ticks and
// contexts. Without it one tick re-rendered the whole subtree below it.
const WidgetRenderer = memo(WidgetRendererImpl);
export default WidgetRenderer;

/**
 * Boundary component mounted only for nodes whose layout contains expressions.
 * It subscribes to the eval context to resolve those values live, keeping that
 * subscription out of every static-layout WidgetRenderer.
 */
function ResolvedLayoutContent({
  layout,
  render,
}: {
  layout?: LayoutConfig;
  render: (layout: LayoutConfig | undefined) => ReactNode;
}) {
  const resolved = useResolvedLayout(layout);
  return <>{render(resolved)}</>;
}
