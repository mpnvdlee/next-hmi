/**
 * Tiny pub/sub for `config_changed` WebSocket events.
 *
 * Runtime-side: useWebSocket publishes here so it never imports the
 * config-only conflict store (which would drag config code into the
 * operator bundle).
 *
 * Config-side: ConfigShell subscribes from a useEffect and forwards
 * to the conflict store. The bus has no Zustand or React deps.
 */

type ArtifactType =
  'page' | 'datasource' | 'alarms' | 'translations' | 'asset' | 'variables' | 'component';

interface ConfigChangedEvent {
  artifact_type: ArtifactType;
  artifact_ids: string[];
  source: 'mcp' | 'rest';
  agent_label?: string;
  summary: string;
  diff?: unknown;
}

type Listener = (event: ConfigChangedEvent) => void;

const listeners = new Set<Listener>();

export function subscribeConfigChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishConfigChanged(event: ConfigChangedEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // listeners must not break each other
    }
  }
}
