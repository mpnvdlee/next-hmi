// ── Datasource types ─────────────────────────────────────────────────────────

export type DatasourceType = 'opcua-client' | 'static' | 'opcua-test-server';

/** How the variable-table UI treats each datasource type, so call sites look up
 *  a capability instead of branching on the type string. */
interface DatasourceCapabilities {
  /** The variable tree can be edited (add/remove/rename, change types). */
  editable: boolean;
  /** Type editor variant for editable rows: HMI simple types vs raw OPC-UA types. */
  typeEditor: 'simple' | 'opcua';
  /** Read-only rows show a dual local(simple)/remote(raw) type display. */
  dualType: boolean;
}

export const DATASOURCE_CAPABILITIES: Record<DatasourceType, DatasourceCapabilities> = {
  'opcua-client': { editable: false, typeEditor: 'simple', dualType: true },
  static: { editable: true, typeEditor: 'simple', dualType: false },
  'opcua-test-server': { editable: true, typeEditor: 'opcua', dualType: false },
};

// ── Settings per datasource type ─────────────────────────────────────────────

export interface OpcuaClientSettings {
  server_url: string;
  username: string;
  password: string;
  security_policy: string;
  security_mode: string;
  client_certificate: string;
  client_private_key: string;
  client_private_key_password: string;
  server_certificate: string;
  reconnect_interval_s: number;
  bg_publish_interval_ms?: number;
  priority_publish_interval_ms?: number;
  priority_sampling_interval_ms?: number;
  priority_ws_batch_ms?: number;
  disable_background_sync?: boolean;
  browse_root_node?: string;
}

interface StaticSettings {
  // No connection settings for static variables
}

export interface TestServerSettings {
  port: number;
  endpoint_path: string;
}

export type DatasourceSettings = OpcuaClientSettings | StaticSettings | TestServerSettings;

// ── Variable tree nodes ──────────────────────────────────────────────────────

export interface FolderEntry {
  kind: 'folder';
  name: string;
  node_id?: string;
  // true = this folder's `[0]`, `[1]`, … child sub-folders are array-of-struct
  // elements. See frontend/src/shared/types/arrayShape.ts.
  is_array?: boolean;
  children: TreeNode[];
}

export interface VariableEntry {
  kind: 'variable' | 'struct';
  node_id?: string;
  display_name: string;
  data_type: string;
  // Array encoding: is_array=true + no/non-positive array_length => dynamic
  // length; is_array=true + positive array_length => fixed size; is_array
  // absent/false => scalar. See frontend/src/shared/types/arrayShape.ts.
  is_array?: boolean;
  array_length?: number;
  enabled: boolean;
  writable?: boolean;
  fields?: Record<string, string>;
  // Numeric range, used to auto-clamp/validate bound input widgets. Applies
  // to scalar variables and to struct fields (a struct's fields are plain
  // VariableEntry nodes nested inside a folder).
  min?: number;
  max?: number;
  // false = variable is in the saved tree but no longer present on the OPC-UA
  // server. Subscriptions are skipped for stale vars; cleared on reappearance.
  present_on_server?: boolean;
}

export type TreeNode = FolderEntry | VariableEntry;

// ── Datasource config (matches JSON file structure) ──────────────────────────

export interface DatasourceConfig {
  type: DatasourceType;
  name: string;
  settings: DatasourceSettings;
  variables: TreeNode[];
}

// ── API response types ───────────────────────────────────────────────────────

export interface DatasourceListItem {
  name: string;
  type: DatasourceType;
  connected: boolean;
  variable_count: number;
  enabled_count: number;
  error?: string | null;
}

// ── Connection-wizard discovery / probe (POST /discover, /test-connection) ────

export interface DiscoveredEndpoint {
  endpoint_url: string;
  /** 'None' | 'Sign' | 'SignAndEncrypt' */
  security_mode: string;
  /** 'NoSecurity' | 'Basic256Sha256' | 'Aes128Sha256RsaOaep' | … */
  security_policy: string;
  /** subset of 'Anonymous' | 'Username' | 'Certificate' */
  user_tokens: string[];
  server_name: string;
  application_uri: string;
}

export interface DiscoveryResult {
  ok: boolean;
  error?: string | null;
  endpoints: DiscoveredEndpoint[];
}

export interface TestConnectionResult {
  ok: boolean;
  error?: string | null;
  server_name?: string | null;
  namespace_count?: number | null;
}

// ── Composite key helpers ────────────────────────────────────────────────────

export function buildVarKey(datasource: string, path: string): string {
  return `${datasource}:${path}`;
}

export function parseVarKey(key: string): { datasource: string; path: string } {
  const idx = key.indexOf(':');
  if (idx < 0) return { datasource: '', path: key };
  return { datasource: key.slice(0, idx), path: key.slice(idx + 1) };
}

// ── Type guards ──────────────────────────────────────────────────────────────

export function isFolder(node: TreeNode): node is FolderEntry {
  return (node as FolderEntry).kind === 'folder';
}

export function isOpcuaClientSettings(s: DatasourceSettings): s is OpcuaClientSettings {
  return 'server_url' in s;
}

export function isTestServerSettings(s: DatasourceSettings): s is TestServerSettings {
  return 'port' in s;
}

// ── Default settings factories ───────────────────────────────────────────────

function defaultSettings(type: DatasourceType): DatasourceSettings {
  switch (type) {
    case 'opcua-client':
      return {
        server_url: 'opc.tcp://localhost:4840',
        username: '',
        password: '',
        security_policy: 'NoSecurity',
        security_mode: 'SignAndEncrypt',
        client_certificate: '',
        client_private_key: '',
        client_private_key_password: '',
        server_certificate: '',
        reconnect_interval_s: 5,
        bg_publish_interval_ms: 1000,
        priority_publish_interval_ms: 50,
        priority_sampling_interval_ms: 20,
        priority_ws_batch_ms: 10,
      };
    case 'static':
      return {};
    case 'opcua-test-server':
      return {
        port: 4855,
        endpoint_path: '/nexthmi/test/',
      };
  }
}

export function defaultDatasource(type: DatasourceType, name: string): DatasourceConfig {
  return {
    type,
    name,
    settings: defaultSettings(type),
    variables: [],
  };
}
