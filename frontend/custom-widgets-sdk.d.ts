/**
 * Ambient type declarations for the NEXT HMI custom component SDK.
 *
 * All of these are available as globals inside &lt;project&gt;/custom-widgets/{Name}/index.tsx
 * because the backend widget compiler prepends the window.__nextHMI__ destructure
 * as a banner in the compiled index.js.
 *
 * SDK version: see `SDK_VERSION` in `shared/utils/nextHmiSdkNames.ts` and
 * docs/dev/reference/custom-widgets.md's "Runtime SDK" section.
 */

/* eslint-disable no-var, @typescript-eslint/no-explicit-any */

declare namespace JSX {
  interface Element {}
  interface IntrinsicElements {
    [elemName: string]: any;
  }
}

declare namespace React {
  type CSSProperties = Record<string, string | number | undefined>;
  interface MouseEvent<T = Element> {
    currentTarget: T;
    target: EventTarget;
    preventDefault(): void;
    stopPropagation(): void;
  }
  interface ChangeEvent<T = Element> {
    currentTarget: T;
    target: T & { value: string; checked: boolean };
  }
  interface KeyboardEvent<T = Element> {
    currentTarget: T;
    key: string;
    preventDefault(): void;
    stopPropagation(): void;
  }
  /** Component type usable as a JSX tag: `React.Fragment`, `React.Suspense`. */
  type ElementType = (props: any) => JSX.Element | null;
}

declare const React: {
  createElement(type: any, props?: any, ...children: any[]): JSX.Element;
  /** Groups siblings without a wrapper element. Needs a `key` in a list. */
  Fragment: React.ElementType;
  /** Boundary for a lazily-resolving child — the built-in icon components
   *  resolve through one, so render them inside it. */
  Suspense: React.ElementType;
  /** Helpers for the opaque `children` prop a `hostsChildren` widget receives. */
  Children: {
    count(children: unknown): number;
    toArray(children: unknown): unknown[];
    map(children: unknown, fn: (child: unknown, index: number) => unknown): unknown[];
  };
};

declare function useState<S>(
  initialState: S | (() => S),
): [S, (value: S | ((prev: S) => S)) => void];

declare function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;

declare function useRef<T>(initialValue: T): { current: T };
declare function useRef<T>(initialValue: T | null): { current: T | null };

declare function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;

declare function useCallback<T extends (...args: any[]) => any>(
  callback: T,
  deps: readonly unknown[],
): T;

declare function createPortal(
  children: unknown,
  container: Element | DocumentFragment,
): JSX.Element | null;

/** Actions bound to a widget's events, as edited by an `actions` schema field.
 *  Pass the event's array to `executeWidgetActions`. */
interface ActionsConfig {
  onPress?: ComponentAction[];
  onChange?: ComponentAction[];
  [event: string]: ComponentAction[] | undefined;
}

/** Mirrors `LayoutConfig` in `shared/types/config.ts` — layout is flex, never grid. */
interface LayoutConfig {
  // Container — flex arrangement of children
  direction?: 'row' | 'column';
  gap?: string;
  wrap?: boolean;
  align?: string;
  justify?: string;

  // Container — inner spacing
  padding?: string;
  paddingTop?: string;
  paddingRight?: string;
  paddingBottom?: string;
  paddingLeft?: string;

  // Container — shape
  /** Corner radius. Unset → theme `--hmi-radius`; set → this literal value. */
  radius?: string;

  // Self — sizing
  width?: string;
  height?: string;
  minWidth?: string;
  maxWidth?: string;
  minHeight?: string;

  // Self — flex placement
  alignSelf?: string;
  basis?: string;
  grow?: number;
  shrink?: number;

  // Self — spacing
  margin?: string;
  marginTop?: string;
  marginRight?: string;
  marginBottom?: string;
  marginLeft?: string;
}

interface VariableBinding {
  /** Composite "datasource:location" key, e.g. "MyPLC:Motor1/Speed". */
  path: string;
  index?: number;
}

/** Mirrors `EvaluationContext` in `hmi/utils/propertySourceEval.ts` — one resolver
 *  per property source. Everything is optional: a context that omits a resolver
 *  makes the matching source evaluate to absent. */
interface EvaluationContext {
  resolveVariable?: (datasource: string, path: string) => unknown;
  resolveTranslation?: (key: string) => string;
  getUrlParam?: (name: string) => string | undefined;
  isPageActive?: (pageId: string) => boolean;
  /** Page id of the renderer scope — the fallback target for `$pageIsActive`. */
  hostPageId?: string;
  resolveUser?: (field: 'username' | 'groups') => string | null;
  /** Raw group ids of the signed-in user, for `$userGroups` membership tests. */
  resolveUserGroups?: () => string[];
  /** Every username in the project, for `$user` with `field: 'userList'`. */
  resolveUserList?: () => string[];
  resolveDevice?: (field: 'hostname' | 'ipAddress' | 'macAddress') => string | null;
  resolveTime?: (format?: string, timezone?: string) => string | null;
  resolveComponentProp?: (componentId: string, property: string) => unknown;
  resolveAlarmCount?: (filter: 'all' | 'unacked' | 'error' | 'warning' | 'info') => number;
  resolveRecipe?: (
    typeId: string,
    field: 'activeName' | 'loaded' | 'parametersChanged',
  ) => string | boolean;
  resolveRecipeList?: (typeId: string) => RecipeRow[];
  resolvePagePath?: (pageId?: string) => PagePathSegment[];
  resolvePage?: (field: string, pageId?: string, separator?: string) => unknown;
  resolveViewport?: (field: 'size' | 'width' | 'height' | 'orientation') => unknown;
  /** Innermost input scope at the read site — drives `$componentProp` nested
   *  inside other sources and inside action payloads. */
  inputScopeProps?: Record<string, unknown>;
  /** Backend response exposed to onSuccess / onFailed / onSettled handlers via
   *  `$result`. Absent in every other context. */
  resultValue?: Record<string, unknown>;
}

interface PagePathSegment {
  id: string;
  label: string;
}

type PageTitle = string | Record<string, unknown>;

interface PageNodeBase {
  id: string;
  title: PageTitle;
  icon?: string;
  description?: string;
  breadcrumbLabel?: string;
  hidden?: boolean;
  role?: string[];
  order?: number;
}

interface PageConfig extends PageNodeBase {
  type?: 'page';
  showHeader?: boolean;
  showFooter?: boolean;
  sections: Record<string, unknown[]>;
}

interface PageGroupConfig extends PageNodeBase {
  type: 'page-group';
  children: PageGroupChild[];
  showChildPagesInMenu?: boolean;
}

type PageGroupChild = PageConfig | PageGroupConfig;
type PageNode = PageConfig | PageGroupConfig;

interface PageGroupStackEntry {
  group: PageGroupConfig;
  /** The active immediate child of `group` — a page or a nested group. */
  activePage: PageGroupChild;
  onNavigate: (pageId: string) => void;
}

interface HmiWidgetProps {
  id?: string;
  properties?: Record<string, unknown>;
  layout?: LayoutConfig;
  children?: unknown;
}

type OverlaySize = 'auto' | 'small' | 'medium' | 'fullscreen' | 'fixed';
type OverlayPlacement =
  | 'center'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'trigger-above'
  | 'trigger-below'
  | 'trigger-left'
  | 'trigger-right';
type OverlayBackdrop = 'dim' | 'none';

type ComponentAction =
  | {
      type: 'openDialog';
      dialogId: string;
      componentProperties?: Record<string, unknown>;
      size?: OverlaySize;
      placement?: OverlayPlacement;
      backdrop?: OverlayBackdrop;
      /** Width in pixels — only relevant when size is 'fixed'. */
      width?: number;
      /** Height in pixels — only relevant when size is 'fixed'. */
      height?: number;
    }
  | { type: 'closeDialog'; dialogId?: string }
  | {
      type: 'openPageOverlay';
      pageId: string;
      size?: OverlaySize;
      placement?: OverlayPlacement;
      backdrop?: OverlayBackdrop;
      /** Width in pixels — only relevant when size is 'fixed'. */
      width?: number;
      /** Height in pixels — only relevant when size is 'fixed'. */
      height?: number;
    }
  | { type: 'closePageOverlay'; pageId?: string }
  | {
      type: 'writeDataVariable';
      datasource: string;
      path: string;
      value: string | number | boolean;
      onSuccess?: ComponentAction[];
      onFailed?: ComponentAction[];
      onSettled?: ComponentAction[];
    }
  | {
      type: 'loginUser';
      username: unknown;
      password: unknown;
      onSuccess?: ComponentAction[];
      onFailed?: ComponentAction[];
      onSettled?: ComponentAction[];
    }
  | {
      type: 'logoutUser';
      onSuccess?: ComponentAction[];
      onFailed?: ComponentAction[];
      onSettled?: ComponentAction[];
    }
  | {
      type: 'recipeLoad';
      datasetId: unknown;
      verify?: boolean;
      onSuccess?: ComponentAction[];
      onFailed?: ComponentAction[];
      onSettled?: ComponentAction[];
    }
  | {
      type: 'recipeSave';
      datasetId?: unknown;
      onSuccess?: ComponentAction[];
      onFailed?: ComponentAction[];
      onSettled?: ComponentAction[];
    }
  | { type: 'setLanguage'; language: unknown }
  | { type: 'setActiveTheme'; theme: unknown }
  | {
      type: 'showAlert';
      title: unknown;
      description: unknown;
      cancelText: unknown;
      okText: unknown;
      dismissible?: boolean;
      onCancel?: ComponentAction[];
      onOk?: ComponentAction[];
    }
  | {
      type: 'showToast';
      message: unknown;
      severity: 'info' | 'warning' | 'error';
      discard: 'auto' | 'manual';
      duration?: number;
    };

/**
 * A field's `type` is a value type (`boolean` | `integer` | `float` |
 * `string` | `datetime` | `date` | `time` | `duration`), one of their arrays
 * (`'float[]'` …), a named struct (`'struct'`, `'Alarms[]'`, …), or an
 * editor-only kind (`color` | `icon` | `image` | `option-list` |
 * `record-list` | `actions` | `groups` | `image-indicators` |
 * `child-positions` | `page-group`). It may also be a list — the first entry
 * drives the editor control, the rest form the variable-binding filter (e.g.
 * `['float','integer','boolean']` or `['option-list','string[]','integer[]']`).
 *
 * The `type` alone decides which property sources (`$static`, `$var`, `$loc`,
 * `$if`, …) the editor offers for the field.
 */
type SchemaType = string;

interface SchemaField {
  type: SchemaType | SchemaType[];
  label: string;
  /** One line explaining what the property does, shown under the label in the
   *  property panel. Keep units in the label (`Size (px)`), behaviour here. */
  description?: string;
  /** Section this property is filed under in the properties panel. Ungrouped
   *  fields share one "Properties" section, in declaration order. */
  group?: string;
  /** Refines the base type's editor without changing the stored value or its source rules. */
  format?: string;
  defaultValue?: unknown;
  /** Empty-state hint for `string`, numeric, `icon` and `image` inputs. */
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  requiredFields?: (
    | string
    | {
        name: string;
        write?: boolean;
        type?: SchemaType;
        requiredFields?: (string | { name: string; write?: boolean; type?: SchemaType })[];
      }
  )[];
  write?: boolean;
  options?: { label: string; value: string | number | boolean; icon?: string }[];
  /** Only with `format: 'select'`: how the options render. */
  display?: 'auto' | 'dropdown' | 'button-text' | 'button-icon';
  /** For a `color` field: the theme token (e.g. `--hmi-accent`) an unset value
   *  falls back to in your CSS, so the picker can show it as themed. */
  defaultToken?: string;
  /** Conditional visibility — a condition or an AND-joined array, referencing sibling keys. */
  visibleWhen?: unknown;
  event?: string;
}

interface ExportedStructField {
  name: string;
  type?: string;
  write?: boolean;
}

interface ExportedProperty {
  key: string;
  label: string;
  type?: string;
  /** For a `Struct` export: declared fields with datatypes, shown in the $widgetProp picker. */
  structSchema?: ExportedStructField[];
}

type IconValue = { type: 'builtin'; name: string } | { type: 'custom'; path: string };

/**
 * Optional module-level exports a widget can declare for the editor's widget selector
 * (the drawer opened via **Browse widgets…** on the tree context menu):
 *
 *   export const category = 'Process'; // defaults to the source folder
 *   export const description = 'One-line summary shown on the widget card.';
 *   export const icon = { type: 'builtin', name: 'gauge' } as const;
 *
 * `icon` has the IconValue shape used by the editor's icon picker. All
 * metadata exports are optional; a widget without an icon uses a generic puzzle-piece.
 */

declare function useVariable(key: string): unknown;
declare function useBindingValue(binding: VariableBinding | undefined): unknown;
declare function useStructVariable(key: string): Record<string, unknown> | unknown[];
declare function useEvalContext(): EvaluationContext;

type VarType =
  | {
      kind: 'scalar';
      base: 'Boolean' | 'Integer' | 'Float' | 'String' | 'DateTime' | 'Date' | 'Time' | 'Duration';
      array: boolean;
      /** Fixed array length, when known. */
      length?: number;
    }
  | {
      kind: 'struct';
      name: string;
      fields: string[];
      array: boolean;
    };

interface VarMeta {
  /** Canonical variable type, including array and struct shape. */
  type: VarType;
  /** Configured numeric range — scalar variables only. */
  min?: number;
  max?: number;
  /** Configured numeric range per field — structs only. */
  fieldRanges?: Record<string, { min?: number; max?: number }>;
}
declare function useVariableMeta(key: string): VarMeta | undefined;

/** Low-level frame send. Prefer `useWriteVariable` for variable writes: without
 *  a `requestId` the backend emits no `write_response` / `write_error`, so a
 *  rejected write is invisible to the operator. */
declare function sendWsMessage(msg: {
  type: 'write' | 'write_field';
  requestId?: string;
  scope?: string;
  datasource: string;
  path: string;
  field?: string;
  value: unknown;
}): void;

interface WriteVariableOptions {
  /**
   * How a rejected write is surfaced. `'toast'` (the default) shows one error
   * toast; `'silent'` swallows it; a function receives the raw reason code.
   */
  onError?: 'toast' | 'silent' | ((reason: string) => void);
  /**
   * Correlate each write with a `requestId` so the backend answers and a
   * rejection can be reported — the default, and what a discrete control
   * (button, switch, numpad commit) needs. Pass `false` from a continuous
   * writer such as a slider drag: every tracked write costs a pending-map
   * entry, a 10 s timer and a response frame, which at drag rates is a hot
   * path. Local coercion still applies; only backend rejections go unseen.
   */
  tracked?: boolean;
}
interface WriteVariable {
  (value: unknown, opts?: { field?: string }): void;
  /**
   * Whether a `$var` binding resolved. When false every call is a no-op, so a
   * widget gates its control on this instead of on the presence of a property:
   * a `$static` / `$if` / `$widgetProp` source yields a value to display but
   * nothing to write to, and an enabled control would swallow the interaction.
   */
  canWrite: boolean;
}
/** Returns a writer for the `$var` binding on `properties[propKey]`; a no-op
 *  when the property holds no binding — `canWrite` says which. Coerces and
 *  range-checks against the variable's metadata, correlates the write with a
 *  `requestId`, and reports a rejection per `options.onError`. Pass
 *  `{ field }` for a struct-field write. */
declare function useWriteVariable(
  properties: Record<string, unknown> | undefined,
  propKey: string,
  options?: WriteVariableOptions,
): WriteVariable;

declare function useHmiScope(): string;
declare function executeWidgetActions(
  actions: ComponentAction[] | undefined,
  context?: { scope?: string; evalCtx?: EvaluationContext; anchorEl?: HTMLElement | null },
): void;
declare function usePublishWidgetProp(
  componentId: string | undefined,
  key: string,
  value: unknown,
): void;

declare function useUsersData(): Array<{ id: number; username: string }>;
declare function useUserGroupsData(): Array<{ id: string; label: string }>;
declare function useLanguagesData(): Array<{ code: string }>;
/** The active language and the setter that changes it — the other half of
 *  `useLanguagesData`, for shipping your own language picker. */
declare function useLanguageSelection(): {
  activeLanguage: string;
  setActiveLanguage: (code: string) => void;
};

// ── Recipes ──────────────────────────────────────────────────────────────────
type RecipeDataType =
  | 'boolean'
  | 'integer'
  | 'float'
  | 'string'
  | 'datetime'
  | 'boolean[]'
  | 'integer[]'
  | 'float[]'
  | 'string[]'
  | 'datetime[]';
interface RecipeParameter {
  id: string;
  label: string;
  /** Binding to a writable variable, e.g. `{ $var: { path: 'datasource:location' } }`. */
  binding: unknown;
  /** Inferred from the bound variable when the parameter is added. */
  dataType: RecipeDataType;
}
interface RecipeDataset {
  id: string;
  name: string;
  description: string;
  values: Record<string, unknown>;
  updatedAt: string;
  updatedBy: string;
  /** Set whenever this dataset is downloaded to variables. */
  loadedAt: string;
}
interface RecipeDatasetType {
  id: string;
  name: string;
  parameters: RecipeParameter[];
  datasets: RecipeDataset[];
}
interface RecipeConfig {
  version: number;
  datasetTypes: RecipeDatasetType[];
}
interface RecipeState {
  loaded: Record<string, { datasetId: string; loadedAt: string }>;
}
interface DownloadResult {
  result: 'success' | 'partial' | 'failed';
  datasetId: string;
  written: number;
  total: number;
  verified: boolean;
  failures: Array<{ parameterId: string; reason: string }>;
}
/** One row of the $recipeList property source — a saved dataset flattened for a grid. */
interface RecipeRow {
  id: string;
  name: string;
  description: string;
  lastLoaded: string;
}
declare function useRecipeConfig(): RecipeConfig;
declare function useRecipeState(): RecipeState;
declare function recipeDownload(
  datasetId: string,
  opts?: { verify?: boolean },
): Promise<DownloadResult>;
declare function recipeUpload(datasetId: string): Promise<RecipeConfig>;

// ── Alarms ───────────────────────────────────────────────────────────────────
type AlarmLevel = 'error' | 'warning' | 'info';

/** Denormalized active alarm instance pushed via WebSocket. */
interface AlarmInstance {
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

interface AlarmSummary {
  total: number;
  unacked: number;
  error_count: number;
  warning_count: number;
  info_count: number;
}

/** Live active alarms, as pushed over the WebSocket. */
declare function useActiveAlarms(): AlarmInstance[];
/** Live alarm counts, pushed alongside the active list. */
declare function useAlarmSummary(): AlarmSummary;
/** Resolves alarm text through the active language's dictionary, and re-renders
 *  the caller when the language changes. */
declare function useAlarmText(): (text: string) => string;
/** The current HMI actor username, falling back to 'operator'. */
declare function useAlarmUsername(): string;
/** Class publishing a severity as `--hmi-alarm-level` on an alarm surface. */
declare function alarmLevelClass(level: AlarmLevel): string;
/** Composed class string for an alarm level indicator dot. */
declare function levelDotClass(level: AlarmLevel): string;
/** ISO timestamp as a short local time (HH:MM:SS); '' when empty. */
declare function formatAlarmTimeShort(iso: string): string;
/** ISO timestamp as a full local date and time; '—' when empty. */
declare function formatAlarmDateTime(iso: string): string;
interface AckAlarmOptions {
  /**
   * How a refused acknowledgement is surfaced. `'toast'` (the default) shows one
   * error toast; `'silent'` swallows it; a function receives the raw reason.
   */
  onError?: 'toast' | 'silent' | ((reason: string) => void);
}
/** Acknowledge one alarm instance. Resolves `true` when the backend accepted it
 *  and `false` when it refused; it never rejects, and reports a refusal per
 *  `options.onError` — so ignoring the result still puts the failure on screen.
 *  Sequence anything that must only happen on success on the returned value. */
declare function ackAlarm(
  instanceId: string,
  username: string,
  options?: AckAlarmOptions,
): Promise<boolean>;
/** Acknowledge every active alarm. Same contract as `ackAlarm`. */
declare function ackAllAlarms(username: string, options?: AckAlarmOptions): Promise<boolean>;
/** The product's alarm detail dialog, rendered as a modal over the page. */
declare const AlarmDetailDialog: (props: {
  alarm: AlarmInstance;
  username: string;
  onClose: () => void;
}) => JSX.Element;

declare function usePageGroup(groupId?: string): PageGroupStackEntry | null;
declare function usePageTitle(title: PageTitle): string;
/** Non-reactive form of `usePageTitle`, for resolving titles inside a loop
 *  where a hook cannot be called. Does not re-render on a language switch. */
declare function resolvePageTitle(title: PageTitle): string;
declare function useNavigateToPage(): (pageId: string) => void;
declare function useVisiblePages(): PageNode[];

interface PhosphorIconProps {
  size?: number | string;
  weight?: 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';
  color?: string;
  className?: string;
}
/**
 * A built-in icon — not a plain component. It is a `React.lazy` wrapper: the
 * icon set is fetched on first render, so rendering one *outside* a
 * `React.Suspense` boundary throws a promise instead of drawing anything.
 * Every use looks like the stdlib widgets' (`Icon`, `Button`, `Tab Bar`, …):
 *
 *     <React.Suspense fallback={null}>
 *       <IconComp size={20} weight="regular" />
 *     </React.Suspense>
 */
type PhosphorIconComponent = ((props: PhosphorIconProps) => JSX.Element) & {
  /** React's marker for a lazily-resolved component. Declared so the type
   *  cannot be read as an ordinary function safe to render bare. */
  readonly $$typeof: symbol;
};
declare function isBuiltinIconId(value: string): boolean;
declare function getBuiltinIconComponent(iconId: string): PhosphorIconComponent | null;
/** True when an icon value points at a workspace SVG rather than a built-in id. */
declare function isCustomIconAssetPath(value: string): boolean;
/**
 * Fetches an SVG asset and returns its markup *rewritten for tinting*: every
 * `fill`, `stroke` and `color` attribute is stripped and a
 * `*{fill:currentColor!important;stroke:none!important}` style block is injected,
 * so the glyph takes the CSS `color` of its parent. A multi-colour source comes
 * back monochrome and stroke-drawn artwork comes back unstroked — fetch the
 * asset yourself (with `withBase`) when you need it to keep its own palette.
 *
 * Returns `''` for a null/empty url, while the fetch is in flight, *and* when
 * the fetch fails — the three are indistinguishable, so treat `''` as "nothing
 * to draw" rather than as a loading state.
 *
 * Render the result with `dangerouslySetInnerHTML`: the markup comes from the
 * project's own asset folder, an editor-writable surface that is already trusted.
 */
declare function useInlineSvg(url: string | null | undefined): string;

/** Prefixes an absolute app path with the instance base, so a URL still
 *  resolves when the project is proxied under /runtime/<slug>/ or /editor/<slug>/. */
declare function withBase(path: string): string;
/** What `apiJson` throws when the backend answers non-2xx: `message` is the
 *  response body's `detail` (or `HTTP <status>` when it carried none), `status`
 *  the HTTP status, `code` the body's machine-readable `code` when it had one. */
interface ApiError extends Error {
  status: number;
  code: string | null;
}
/** True when a caught value is an `ApiError` — the request reached the backend
 *  and it refused. A request that never got there (offline, backend down)
 *  rejects with a plain `TypeError` instead, so discriminate with this rather
 *  than assuming `status` is there to read. */
declare function isApiError(value: unknown): value is ApiError;
/** Fetches JSON from a backend endpoint, base-prefixed. Resolves the parsed body,
 *  or `undefined` for a `204 No Content` — hence `T | undefined`. Throws
 *  `ApiError` on any non-2xx (see `isApiError`). */
declare function apiJson<T = unknown>(
  url: string,
  options?: { method?: string; body?: unknown; signal?: AbortSignal },
): Promise<T | undefined>;

declare function selfLayoutStyle(
  layout?: LayoutConfig,
): Record<string, string | number> | undefined;
/** The `--container-*` half of a layout, for a widget that declares
 *  `hostsChildren` and lays its children out itself. Pair it with a stylesheet
 *  that resets every `--container-*` it reads to `initial`, or a nested host
 *  inherits its parent's direction and gap. */
declare function containerLayoutStyle(
  layout?: LayoutConfig,
): Record<string, string | number> | undefined;
declare function widgetColorStyle(color: string | undefined): Record<string, string>;

declare function bindingKey(binding: VariableBinding | unknown): string;
declare function parseVarKey(key: string): { datasource: string; path: string };

declare function getPropString(
  properties: Record<string, unknown> | undefined,
  key: string,
  fallback?: string,
  evalCtx?: EvaluationContext,
): string;

declare function getPropNumber(
  properties: Record<string, unknown> | undefined,
  key: string,
  fallback?: number,
  evalCtx?: EvaluationContext,
): number;

declare function getPropBoolean(
  properties: Record<string, unknown> | undefined,
  key: string,
  fallback?: boolean,
  evalCtx?: EvaluationContext,
): boolean;

declare function getPropBinding(
  properties: Record<string, unknown> | undefined,
  key: string,
): VariableBinding | undefined;

declare function getPropBindingOrStatic(value: unknown): {
  binding: VariableBinding | undefined;
  staticValue: unknown;
};

declare function usePropVar(properties: Record<string, unknown> | undefined, key: string): unknown;

declare function usePropString(
  properties: Record<string, unknown> | undefined,
  key: string,
  fallback?: string,
): string;

declare function usePropNumber(
  properties: Record<string, unknown> | undefined,
  key: string,
  fallback?: number,
): number;

declare function usePropBoolean(
  properties: Record<string, unknown> | undefined,
  key: string,
  fallback?: boolean,
): boolean;

declare function usePropStruct(
  properties: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | unknown[];

/**
 * Read a `record-list` property (array of records) regardless of its source:
 * a `$var` struct-array binding, the `$recipeList` property source, a `$widgetProp`
 * export, or a plain static array. Cast rows/cells at the call site.
 */
declare function useRecordListProp(
  properties: Record<string, unknown> | undefined,
  key: string,
): unknown[];

declare function useCssVar(varName: string, fallback: string): string;

declare var Recharts: any;

interface VirtualKeyboardProps {
  isOpen: boolean;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  anchorRef?: { readonly current: Element | null };
  title?: string;
  /** Masks the value preview while preserving its character count. */
  password?: boolean;
}

interface VirtualNumpadProps {
  isOpen: boolean;
  value: string;
  onChange: (value: string) => void;
  onClose: (value: string) => void;
  anchorRef?: { readonly current: Element | null };
  title?: string;
  dockPosition?: 'center' | 'bottom-right';
  /** Range/unit hint shown under the title. Reddens the value preview and disables Enter when out of range. Omit to hide. */
  min?: number;
  max?: number;
  unit?: string;
}

interface CloseButtonProps {
  label?: string;
  tone?: 'hmi' | 'config' | 'inverse';
  className?: string;
  title?: string;
  tabIndex?: number;
  disabled?: boolean;
  style?: React.CSSProperties;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseDown?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

declare function VirtualKeyboard(props: VirtualKeyboardProps): JSX.Element | null;
declare function VirtualNumpad(props: VirtualNumpadProps): JSX.Element | null;
declare function CloseButton(props: CloseButtonProps): JSX.Element;
