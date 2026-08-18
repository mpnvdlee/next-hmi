// ── Alarm types (mirrors backend models/alarm.py) ────────────────────────────

export type AlarmLevel = 'error' | 'warning' | 'info';
export type AlarmTriggerType = 'value_range' | 'bool';
export type AlarmCountFilter = 'all' | 'unacked' | 'error' | 'warning' | 'info';

export interface AlarmTrigger {
  type: AlarmTriggerType;
  /** Binding value for the monitored variable, e.g. { $var: { path: 'datasource:location' } } */
  source_value: unknown;
  /** value_range min threshold — plain number, { $static: n }, or { $var: ... } */
  min: unknown;
  /** value_range max threshold — plain number, { $static: n }, or { $var: ... } */
  max: unknown;
  on_true: boolean;
}

export interface AlarmDefinition {
  id: string;
  code: string;
  level: AlarmLevel;
  /** Title string or localisable expression ({ $loc: key } | { $static: '...' }) */
  title: unknown;
  /** Description string or localisable expression */
  description: unknown;
  /** Image filename or expression binding ({ $var: ... } | { $static: '...' }) */
  image: unknown;
  auto_popup: boolean;
  resolutions: unknown[];
  trigger: AlarmTrigger;
  ack_groups: string[];
}

export interface AlarmGroup {
  id: string;
  title: string;
  alarms: AlarmDefinition[];
}

export interface AlarmConfig {
  version: number;
  groups: AlarmGroup[];
}

/** Denormalized active alarm instance pushed via WebSocket. */
export interface AlarmInstance {
  id: string;
  alarm_id: string;
  code: string;
  level: AlarmLevel;
  title: string;
  description: string;
  image: string;
  resolutions: unknown[];
  group_title: string;
  auto_popup: boolean;
  ack_groups: string[];
  triggered_at: string;
  acked: boolean;
  acked_by: string;
  acked_at: string;
}

export interface AlarmHistoryEntry {
  id: string;
  alarm_id: string;
  code: string;
  level: AlarmLevel;
  title: string;
  group_title: string;
  triggered_at: string;
  cleared_at: string;
  acked: boolean;
  acked_by: string;
  acked_at: string;
}

export interface AlarmSummary {
  total: number;
  unacked: number;
  error_count: number;
  warning_count: number;
  info_count: number;
}
