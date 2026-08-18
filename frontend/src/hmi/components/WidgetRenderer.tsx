/**
 * Recursively renders a component tree node from `config.json`.
 *
 * - Looks up the type in `widgetRegistry`.
 * - Passes `properties` and `layout` as props.
 * - Renders children recursively so Container components receive them.
 * - Falls back to `.hmi-unknown-widget` for unrecognised types.
 *
 * Binding-unavailable overlay:
 * - After the first `var_snapshot` from the server, any component whose
 *   VariableBinding(s) are absent from the variable store (disabled or
 *   not yet published by the PLC) gets a red-cross overlay.
 *
 * Preview mode (set by PreviewContext):
 * - Wraps each component in `<div data-widget-id="..." className="hmi-preview-node">`.
 * - CSS sets `display: contents` on .hmi-preview-node so layout is unaffected.
 * - The PreviewView postMessage bridge then targets [data-widget-id] to apply
 *   `hmi-preview-node--selected` to the wrapper.
 */

import './WidgetRenderer.css';
import { Component, useContext, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode, ErrorInfo } from 'react';
import type { WidgetConfig, LayoutConfig } from '@shared/types/config';
import { useConfigStore } from '@shared/store/configStore';
import { widgetRegistry, isContainerHostType, placesOwnChildren } from '../registry/widgetRegistry';
import { useHmiStore } from '../store/hmiStore';
import { PreviewContext } from '@shared/context/PreviewContext';
import { DefinitionScopeContext } from '../context/DefinitionScopeContext';
import { useBindingStatus } from '../utils/bindingValidation';
import { useResolvedProperties } from '../hooks/useResolvedProperties';
import { useLiveScalars } from '../hooks/useLiveScalars';
import { useTimeTick } from '../hooks/useTimeTick';
import { useHttpTick } from '../hooks/useHttpTick';
import { extractVarKeys } from '../utils/extractVarKeys';
import { usesTime } from '../utils/usesTime';
import { usesHttp } from '../utils/usesHttp';
import { layoutHasPropertySource, useResolvedLayout, usePropBoolean } from './layoutUtils';

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
 * so the component inside isn't a direct flex/grid child of the page.
 */
function wrapperStyle(layout?: LayoutConfig): CSSProperties {
  return {
    position: 'relative',
    flexBasis: layout?.basis,
    flexGrow: layout?.grow ?? 0,
    flexShrink: layout?.shrink ?? 1,
    alignSelf: layout?.alignSelf,
    minWidth: layout?.minWidth,
    maxWidth: layout?.maxWidth,
    minHeight: layout?.minHeight,
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function WidgetRenderer({ node }: { node: WidgetConfig }) {
  const isPreview = useContext(PreviewContext);
  const fromDefinition = useContext(DefinitionScopeContext);
  const entry = widgetRegistry[node.type];

  const isVisible = usePropBoolean(node.properties, 'visible', true);
  const isInteractable = usePropBoolean(node.properties, 'interactable', true);

  const bindingStatus = useBindingStatus(node.properties, entry?.schema ?? {});

  // Resolve translation references in properties ({ "$loc": "key" }).
  const resolvedProperties = useResolvedProperties(node.properties);

  // Granular live-value subscription: re-render this widget only when a `$var`
  // it actually references ticks. `resolvedProperties` already has any parent
  // `$componentProp` substituted to the real `$var`, so nested/component-prop
  // bindings are covered. Layout `$var` is handled by `useResolvedLayout`.
  useLiveScalars(extractVarKeys(resolvedProperties));

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

  // ── Visibility gate ───────────────────────────────────────────────────────
  // All hooks are called above; early return is safe here. `visible` /
  // `interactable` are boolean properties that may hold any expression source
  // (static bool, `$userGroups`, `$var`, `$if`, …); default to true when unset.
  if (!isVisible) {
    return null;
  }

  function handleLockedClick(e: MouseEvent<HTMLDivElement>) {
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

  // Build the rendered subtree from a (possibly resolved) layout. Layout values
  // may carry property sources; they're resolved to plain values before use.
  const buildContent = (layout: LayoutConfig | undefined): ReactNode => {
    const comp = (
      <Comp
        id={node.id}
        properties={resolvedProperties}
        layout={layout}
        childConfigs={isContainerHostType(node.type) ? node.children : undefined}
      >
        {children}
      </Comp>
    );

    // When a binding is unavailable, wrap with a positioned container + overlay
    const content =
      bindingStatus !== 'ok' ? (
        <div className="hmi-binding-wrapper" style={wrapperStyle(layout)}>
          {comp}
          <div
            className={`hmi-binding-overlay hmi-binding-overlay--${bindingStatus}`}
            aria-label={
              bindingStatus === 'disconnected' ? 'OPC UA disconnected' : 'Variable disabled'
            }
          >
            <span className="hmi-binding-overlay__icon" aria-hidden="true" />
          </div>
        </div>
      ) : !isInteractable ? (
        <div
          className="hmi-lock-wrapper"
          style={wrapperStyle(layout)}
          title={lockedFeedback === 'none' ? undefined : LOCKED_MESSAGE}
        >
          {comp}
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

    return isPreview ? (
      <div
        data-widget-id={node.id}
        data-widget-type={node.type}
        data-widget-source={fromDefinition ? 'definition' : undefined}
        className="hmi-preview-node"
      >
        {content}
      </div>
    ) : (
      content
    );
  };

  // Only nodes with expression-bound layout subscribe to live values (via the
  // child boundary); static-layout nodes render directly without that cost.
  const inner = layoutHasPropertySource(node.layout) ? (
    <ResolvedLayoutContent layout={node.layout} render={buildContent} />
  ) : (
    buildContent(node.layout)
  );

  return (
    <WidgetErrorBoundary id={node.id} type={node.type} resetProps={node.properties}>
      {inner}
    </WidgetErrorBoundary>
  );
}

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
