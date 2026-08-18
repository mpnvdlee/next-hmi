/**
 * Tiny pub/sub for `widget_updated` WebSocket events.
 *
 * The backend widget compiler emits this whenever a custom-widget TSX file
 * recompiles. useWebSocket publishes here so the runtime app can react
 * without subscribing to the raw socket.
 *
 * Replaces the old Vite-plugin path that delivered the same signal via
 * `import.meta.hot.on('custom-widget-updated', ...)`. With the plugin gone,
 * the websocket is the only transport in both dev and prod.
 */

interface WidgetUpdatedEvent {
  /** Canonical normalized path relative to custom-widgets/. */
  key: string;
  /** Widget directory basename — matches the historical `data.name` field. */
  name: string;
  /** ISO timestamp of the compile; used as a cache-buster on dynamic imports. */
  ts: string;
  /** False if the schema-manifest regeneration failed alongside this compile. */
  schema_ok: boolean;
}

type Listener = (event: WidgetUpdatedEvent) => void;

const listeners = new Set<Listener>();

export function subscribeWidgetUpdated(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishWidgetUpdated(event: WidgetUpdatedEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      // Listeners must not break each other, but a silent swallow hides
      // real bugs in subscribed components.
      console.error('widgetUpdated listener threw', err);
    }
  }
}
