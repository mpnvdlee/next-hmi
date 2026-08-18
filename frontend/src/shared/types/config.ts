import type { ReactNode } from 'react';
import type { ComponentPropertySchema } from './componentProperty';

export interface LayoutConfig {
  // ── Container — flex arrangement of children ───────────────────────────────
  direction?: 'row' | 'column';
  gap?: string;
  wrap?: boolean;
  align?: string;
  justify?: string;

  // ── Container — inner spacing ──────────────────────────────────────────────
  padding?: string;
  paddingTop?: string;
  paddingRight?: string;
  paddingBottom?: string;
  paddingLeft?: string;

  // ── Container — shape ──────────────────────────────────────────────────────
  /** Corner radius. Unset → theme `--hmi-radius`; set → this literal value. */
  radius?: string;

  // ── Self — sizing ──────────────────────────────────────────────────────────
  width?: string;
  height?: string;
  minWidth?: string;
  maxWidth?: string;
  minHeight?: string;

  // ── Self — flex placement ──────────────────────────────────────────────────
  alignSelf?: string;
  basis?: string;
  grow?: number;
  shrink?: number;

  // ── Self — spacing ─────────────────────────────────────────────────────────
  margin?: string;
  marginTop?: string;
  marginRight?: string;
  marginBottom?: string;
  marginLeft?: string;
}

export interface VariableBinding {
  /** Composite "datasource:location" key, e.g. "MyPLC:Motor1/Speed". The
   *  datasource name before the first ':' selects the connection; the rest is
   *  the slash-separated location of the variable within that datasource. */
  path: string;
  /** Array element index (0-based). When set, resolves to value[index] at runtime. Absent means whole variable. */
  index?: number;
}

/** Extract the composite "datasource:location" key from a VariableBinding. */
export function bindingKey(b: VariableBinding | undefined | null): string {
  return b?.path ?? '';
}

/** Split a binding's composite path into its datasource name and location. */
export function bindingParts(b: VariableBinding | undefined | null): {
  datasource: string;
  location: string;
} {
  const path = b?.path ?? '';
  const idx = path.indexOf(':');
  if (idx < 0) return { datasource: '', location: path };
  return { datasource: path.slice(0, idx), location: path.slice(idx + 1) };
}

// Property source types

/** Visibility condition for schema fields: shows/hides a field based on same-component property values */
export interface VisibilityCondition {
  property: string; // key of another property in the same component schema
  equals?: unknown; // match strict equality OR
  notEquals?: unknown; // match strict inequality
  // Exactly one of equals/notEquals must be present (enforced by validation)
}

/** $var: variable binding to a datasource variable.
 *  The inner shape is the canonical {@link VariableBinding}: a composite
 *  "datasource:location" `path` plus an optional array `index`. */
export interface VarSource {
  $var: VariableBinding;
}

/** $loc: localization key (string only) */
export interface LocSource {
  $loc: string; // translation key
}

/** $urlParam: URL query parameter (with optional static fallback) */
export interface UrlParamSource {
  $urlParam: {
    name: string; // query param name
    default?: unknown; // optional fallback value
  };
}

/** $pageIsActive: boolean check whether current page matches (boolean only) */
export interface PageIsActiveSource {
  $pageIsActive: {
    /** Target page id; omitted/empty means the host page (current renderer scope). */
    page?: string;
  };
}

/** $if: conditional property source (condition + true/false branches) */
export interface IfSource {
  $if: {
    condition: unknown; // value-source-capable (resolves boolean)
    true: unknown; // result when true (raw or wrapper)
    false: unknown; // result when false (raw or wrapper)
  };
}

/** $compare: comparison operator returning boolean */
export interface CompareSource {
  $compare: {
    left: unknown; // value-source-capable
    operator: '>' | '<' | '>=' | '<=' | '===' | '!=='; // comparison operator
    right: unknown; // value-source-capable
  };
}

/** $random: random number (number only) */
export interface RandomSource {
  $random: {
    min: number;
    max: number;
    integer?: boolean; // defaults false (decimal allowed)
  };
}

/** $switch: switch/case with default (value-source → case value → result) */
export interface SwitchSource {
  $switch: {
    value: unknown; // value-source-capable discriminant
    cases: Array<{
      when: unknown; // match case condition
      then: unknown; // result when matched (raw or wrapper)
    }>;
    default: unknown; // fallback result (raw or wrapper)
  };
}

/** $user: current logged-in user data (username, groups, or full user list for items fields) */
export interface UserSource {
  $user: {
    field: 'username' | 'groups' | 'userList';
  };
}

/** $userGroups: boolean — true when the signed-in user is in one of the
 *  selected groups. An empty list means every user (no restriction). */
export interface UserGroupsSource {
  $userGroups: {
    groups: string[];
  };
}

/** $device: client device info supplied by the backend (best-effort hostname/IP/MAC) */
export interface DeviceSource {
  $device: {
    field: 'hostname' | 'ipAddress' | 'macAddress';
  };
}

/** $time: current date/time as a formatted string */
export interface TimeSource {
  $time: {
    format?: string; // e.g. HH:mm:ss, YYYY-MM-DD HH:mm, ISO
    timezone?: string; // e.g. UTC, Europe/Amsterdam
  };
}

/** $widgetProp: read a live exported property value from another component on the same page/dialog */
export interface WidgetPropSource {
  $widgetProp: {
    componentId: string; // id of the source component
    property: string; // exported property key (e.g. 'selectedValue', 'value')
    /** Optional slash-path into a struct/array member of the exported value
     *  (e.g. 'name' or 'sensor/value'). Empty/absent reads the whole value —
     *  used to bind a single field of a struct export like a selected row. */
    path?: string;
  };
}

/** A selected icon — either a built-in Phosphor allowlist icon or a custom workspace icon.
 *  Carried as the payload of a `$static` value on `icon`-typed fields. */
export type IconValue =
  | { type: 'builtin'; name: string } // allowlist id, e.g. 'gauge'
  | { type: 'custom'; path: string }; // relative path under assets/, e.g. 'icons/my.svg'

/** A positioned indicator shown over an Image component. x/y are 0–1 normalized fractions. */
export interface ImageIndicator {
  id: string;
  label: string;
  /** Black pill position (0–1 normalized) */
  x: number;
  y: number;
  /** Red circle position, defaults to x/y when absent */
  rx?: number;
  ry?: number;
  /** Red circle diameter as % of image container width (default 10) */
  rSize?: number;
}

/** A selected image from the live project's assets/images folder.
 *  Carried as the payload of a `$static` value on `image`-typed fields. */
export type ImageValue = {
  path: string; // relative path under assets/, e.g. 'images/logo.png'
};

/** $stringExpr: string template with wildcard placeholders and optional inline functions */
export interface StringExprSource {
  $stringExpr: {
    template: string; // e.g. "{ToLower(1)} - {2}, {Trim(ToLower(3))}"
    wildcards: Record<string, unknown>; // keyed by placeholder number; each value is a standard property value (plain, $var, $loc, etc.)
  };
}

/** A request header on an $http source. Both halves accept `{n}` placeholders. */
export interface HttpHeader {
  name: string;
  value: string;
}

/**
 * $http: a value fetched from an HTTP endpoint.
 *
 * `url`, `body` and every header value are templates using the same `{1}` /
 * `{ToLower(2)}` placeholder syntax as `$stringExpr`, filled from `wildcards`.
 * `path` is a slash-path into the decoded JSON response (`data/0/value`);
 * empty means the whole response. `refreshSeconds` 0/absent fetches once.
 */
export interface HttpSource {
  $http: {
    url: string;
    wildcards?: Record<string, unknown>;
    method?: 'GET' | 'POST';
    headers?: HttpHeader[];
    body?: string;
    path?: string;
    refreshSeconds?: number;
  };
}

/** Field names exposed by the $page binding family. */
export type PageField =
  | 'id'
  | 'title'
  | 'icon'
  | 'description'
  | 'breadcrumbLabel'
  | 'depth'
  | 'parentId'
  | 'pathString'
  | 'pathSegments';

/**
 * $page: read metadata of the active page (default) or any named page.
 * `pathString` joins ancestor titles with `separator` (default ' / ').
 * `pathSegments` returns a JSON-stringified array of `{ id, label }` objects
 * so it can flow through the same string-typed expression channel; consumers
 * that need structured segments can call `useEvalContext().resolvePage` directly.
 */
export interface PageSource {
  $page: {
    field: PageField;
    /** Target a specific page by id; defaults to the current active page. */
    pageId?: string;
    /** For `pathString`: separator between segments. Default ' / '. */
    separator?: string;
  };
}

/** Logical viewport size class. Driven by configurable breakpoints. */
export type ViewportSize = 'phone' | 'tablet' | 'laptop';

/** $viewport: read live viewport state. */
export interface ViewportSource {
  $viewport: {
    field: 'size' | 'width' | 'height' | 'orientation';
  };
}

/** A single segment in a page path, exposed structurally via resolvePage. */
export interface PagePathSegment {
  id: string;
  label: string;
}

/** Manual-mode NavigationMenu item — discriminated by `type`.
 *  Icons are carried as a `$static` value wrapping an {@link IconValue}. */
export type MenuItemConfig =
  | {
      type: 'page-link';
      pageId: string;
      label?: string;
      icon?: { $static: IconValue };
    }
  | {
      type: 'external-link';
      url: string;
      target?: '_self' | '_blank';
      label: string;
      icon?: { $static: IconValue };
    }
  | { type: 'action'; actions: ButtonAction[]; label: string; icon?: { $static: IconValue } }
  | { type: 'divider' }
  | { type: 'section-header'; label: string }
  | { type: 'submenu'; label: string; icon?: { $static: IconValue }; items: MenuItemConfig[] };

export interface WidgetConfig {
  id: string;
  type: string;
  name: string;
  layout?: LayoutConfig;
  properties?: Record<string, unknown>;
  children?: WidgetConfig[];
  /** Only meaningful on a child of a `$component:` instance: which of the
   *  definition's slots this widget fills. Absent means the first slot. */
  slot?: string;
}

export type PageTitle = string | Record<string, unknown>;

interface PageNodeBase {
  id: string;
  title: PageTitle;
  icon?: string;
  /** Long-form description for tooltips, search, accessibility. */
  description?: string;
  /** Overrides title in breadcrumb trails. */
  breadcrumbLabel?: string;
  /** When true, page is routable but absent from menus. */
  hidden?: boolean;
  /** Group ids allowed to see / access this page. Empty / absent = everyone. */
  role?: string[];
  /** Explicit menu ordering — lower comes first. Falls back to insertion order. */
  order?: number;
  /** CSS value for the main region's padding while this node is active. Inner level wins. Defaults to 0. */
  mainPadding?: string;
  /** CSS color for the main region's background while this node is active. Inner level wins. Defaults to white. */
  mainBackground?: string;
}

export interface PageConfig extends PageNodeBase {
  type?: 'page';
  /** When true, page renders a header band above the content section. */
  showHeader?: boolean;
  /** When true, page renders a footer band below the content section. */
  showFooter?: boolean;
  /** Section-keyed map of widgets. Keys: 'content' (always), 'header'/'footer' when the toggle is on. */
  sections: Record<string, WidgetConfig[]>;
  /** Per-page shell overrides. Merged on top of the project's ShellConfig. */
  shellOverride?: Partial<ShellConfig>;
}

export interface PageGroupConfig extends PageNodeBase {
  type: 'page-group';
  /** Pages and (optionally) nested page-groups. Page-groups never live inside pages. */
  children: PageGroupChild[];
  /** When true, child pages are listed under this group in the main navigation menu. */
  showChildPagesInMenu?: boolean;
  /** Widgets rendered above every active sub-page in this group. */
  header?: WidgetConfig[];
  /** Widgets rendered below every active sub-page in this group. */
  footer?: WidgetConfig[];
}

export type PageGroupChild = PageConfig | PageGroupConfig;

export type PageNode = PageConfig | PageGroupConfig;

/** Size of a page overlay or dialog modal. `auto` sizes to content (no explicit width/height). */
export type OverlaySize = 'auto' | 'small' | 'medium' | 'fullscreen' | 'fixed';

/** Placement anchor of a page overlay modal.
 *  `trigger-*` values position the panel relative to the element that fired the
 *  action (popover style); the rest are viewport-relative. */
export type OverlayPlacement =
  | 'center'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'trigger-above'
  | 'trigger-below'
  | 'trigger-left'
  | 'trigger-right';

/** Whether an overlay/dialog dims the full-screen backdrop behind it. */
export type OverlayBackdrop = 'dim' | 'none';

/** Bounding box of a trigger element, captured for anchored placement. */
export interface AnchorRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * Reason codes surfaced to onFailed handlers via `{ $result: 'reason' }`.
 * Backend-emitted codes are mirrored in `backend/services/websocket_manager.py`
 * (REASON_* constants); `timeout` and `disconnected` are synthesized client-side
 * by `actionDispatcher`.
 */
export type ActionResultReason =
  | 'invalid_credentials'
  | 'permission_denied'
  | 'bad_request'
  | 'bad_path'
  | 'bad_field'
  | 'invalid_value'
  | 'opcua_unreachable'
  | 'write_failed'
  | 'array_index_out_of_bounds'
  | 'array_state_unavailable'
  | 'timeout'
  | 'disconnected';

/** A single action that can be triggered by a component event (e.g. button press). */
export type ButtonAction =
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
      value: string | number | boolean | unknown[];
      onSuccess?: ButtonAction[];
      onFailed?: ButtonAction[];
      onSettled?: ButtonAction[];
    }
  | {
      type: 'loginUser';
      username: unknown;
      password: unknown;
      /** Fires after the backend acknowledges a successful login. */
      onSuccess?: ButtonAction[];
      /** Fires when the backend rejects the login or the request times out / disconnects. */
      onFailed?: ButtonAction[];
      /** Fires after onSuccess or onFailed, regardless of outcome. */
      onSettled?: ButtonAction[];
    }
  | {
      type: 'logoutUser';
      onSuccess?: ButtonAction[];
      onFailed?: ButtonAction[];
      onSettled?: ButtonAction[];
    }
  | {
      type: 'recipeLoad';
      /** Static or expression — the saved dataset to download. */
      datasetId: unknown;
      verify?: boolean;
      onSuccess?: ButtonAction[];
      onFailed?: ButtonAction[];
      onSettled?: ButtonAction[];
    }
  | {
      type: 'recipeSave';
      /** Omitted = the dataset currently loaded (when exactly one type is loaded). */
      datasetId?: unknown;
      onSuccess?: ButtonAction[];
      onFailed?: ButtonAction[];
      onSettled?: ButtonAction[];
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
      onCancel?: ButtonAction[];
      onOk?: ButtonAction[];
    }
  | {
      type: 'showToast';
      /** The message text (expression-capable: $static, $loc, $var) */
      message: unknown;
      /** Visual severity level */
      severity: 'info' | 'warning' | 'error';
      /** 'auto' dismisses after duration ms; 'manual' requires user action */
      discard: 'auto' | 'manual';
      /** Auto-dismiss timeout in milliseconds (default 4000). Only used when discard is 'auto'. */
      duration?: number;
    };

/** Actions attached to a component, keyed by event name. */
export interface ActionsConfig {
  onPress?: ButtonAction[];
  onChange?: ButtonAction[];
  [key: string]: ButtonAction[] | undefined;
}

/** Global lifecycle events — singleton config, not per-component. */
export interface GlobalEventsConfig {
  onUserLoggedIn?: ButtonAction[];
  onUserLoggedOut?: ButtonAction[];
  onPageLoaded?: ButtonAction[];
  onHmiLoaded?: ButtonAction[];
  onLocaleChanged?: ButtonAction[];
}

/** A named dialog modal — the user builds it like a page. */
export interface DialogConfig {
  id: string;
  title: string;
  closeOnBackgroundPress?: boolean;
  showCloseButton?: boolean;
  /** Component-property schema declarations, mirrors ComponentDefinition.componentProperties. */
  componentProperties?: Record<string, ComponentPropertySchema>;
  widgets: WidgetConfig[];
}

/**
 * Normalized, in-memory aggregate of the page tree + global areas — the shape
 * configStore holds after `normalizePageNodes()` has run. Not what the wire
 * actually sends; see `PagesBootstrapResponse` for that.
 */
export interface PagesConfig {
  pages: PageNode[];
  /** Project-wide shell. Per-page overrides live on PageConfig.shellOverride. */
  shell?: ShellConfig;
  /** Header components — array form, rendered as the header content when shell.header.component is absent. */
  header?: WidgetConfig[];
  /** Footer components — array form, rendered as the footer content when shell.footer.component is absent. */
  footer?: WidgetConfig[];
  /** Left-sidebar components — array form, rendered as the left sidebar content when shell.leftSidebar.component is absent. */
  leftSidebar?: WidgetConfig[];
  /** Right-sidebar components — array form, rendered as the right sidebar content when shell.rightSidebar.component is absent. */
  rightSidebar?: WidgetConfig[];
  dialogs?: DialogConfig[];
  globalEvents?: GlobalEventsConfig;
}

/**
 * Wire response of `GET /api/config/config` — the bootstrap payload. Page
 * entries are index-hydrated but not yet validated: a page whose file hasn't
 * been written yet can arrive without `title` or `sections`. Pass `pages`
 * through `normalizePageNodes()` (the runtime guard) to get `PagesConfig`.
 */
export interface PagesBootstrapResponse {
  pages: unknown[];
  shell?: ShellConfig;
  header?: WidgetConfig[];
  footer?: WidgetConfig[];
  leftSidebar?: WidgetConfig[];
  rightSidebar?: WidgetConfig[];
  dialogs?: DialogConfig[];
  globalEvents?: GlobalEventsConfig;
}

/**
 * Wire response of `GET /api/config/pages/{id}` — one page document, or a
 * `{ id, sections }` stub when the page file doesn't exist yet. Only
 * `sections` is consumed today; run it through `normalizeSections()` before
 * use, since its inner shape isn't guaranteed either.
 */
export interface LazyPageResponse {
  sections?: unknown;
}

export type ShellRegionId = 'header' | 'footer' | 'leftSidebar' | 'rightSidebar';

/** Alias of ShellRegionId — used by call sites that mutate the component arrays. */
export type ShellAreaId = ShellRegionId;

/** Canonical iteration order for shell regions (top → bottom in the editor tree). */
export const SHELL_REGION_IDS: readonly ShellRegionId[] = [
  'header',
  'leftSidebar',
  'rightSidebar',
  'footer',
] as const;

type ShellSectionId = '__header__' | '__footer__' | '__leftSidebar__' | '__rightSidebar__';

export function shellSectionIdForRegion(region: ShellRegionId): ShellSectionId {
  return `__${region}__` as ShellSectionId;
}

export function regionForShellSectionId(sectionId: string): ShellRegionId | null {
  switch (sectionId) {
    case '__header__':
      return 'header';
    case '__footer__':
      return 'footer';
    case '__leftSidebar__':
      return 'leftSidebar';
    case '__rightSidebar__':
      return 'rightSidebar';
    default:
      return null;
  }
}

/**
 * Configuration for a single shell region. Components for the region are
 * authored on `PagesConfig.<region>` (the per-region component arrays) — the
 * shell config only carries the region's *behaviour* (size, collapse state,
 * overlay, etc.).
 */
export interface ShellRegionConfig {
  enabled?: unknown; // boolean, bindable — default true
  expandedSize?: unknown; // string, bindable — e.g. '240px', 'auto'; vertical: width, horizontal: height
  collapsedSize?: unknown; // string, bindable — e.g. '48px', '0'
  expanded?: unknown; // boolean, bindable
  defaultState?: 'expanded' | 'collapsed' | 'hidden';
  overlay?: unknown; // boolean, bindable — Phase 7
  /** Sidebars only, bindable: when true, the sidebar spans the full layout
   *  height, flanking the header/main/footer column instead of sitting
   *  between them. */
  fullHeight?: unknown;
  /** CSS color for the region's background, bindable. Defaults to white. */
  background?: unknown;
}

/** Feedback modes for a press on a non-interactable component. */
export const LOCKED_FEEDBACK_MODES = ['flash', 'toast', 'none'] as const;
export type LockedFeedback = (typeof LOCKED_FEEDBACK_MODES)[number];

export interface ShellConfig {
  header?: ShellRegionConfig;
  footer?: ShellRegionConfig;
  leftSidebar?: ShellRegionConfig;
  rightSidebar?: ShellRegionConfig;
  /** Zoom factor applied to .hmi-layout (CSS `zoom`). Defaults to 1. */
  hmiScale?: number;
  /** When true, scrollable HMI surfaces paint the browser's scrollbars.
   *  Unset (the default) keeps them scrollable but chromeless. */
  showScrollbars?: boolean;
  /** What the operator gets when they press a component whose `interactable`
   *  property resolves false: a ⊘ marker at the pointer (`flash`, the
   *  default), a toast notification (`toast`), or nothing (`none`). The
   *  component stays dimmed and blocked in every mode. */
  lockedFeedback?: LockedFeedback;
  /** Browser tab title. When unset, the document keeps the value from index.html. */
  appTitle?: string;
  /** Favicon path under the live project's assets/ (e.g. "images/logo.svg"), or an absolute URL. */
  appIcon?: string;
  /**
   * Logo shown on the HMI boot screen instead of the product mark and name —
   * a path under the live project's assets/ (e.g. "images/logo.svg").
   * White-label branding, which a commercial licence grants and
   * only the `ee` build offers a setting for. The AGPL-3.0 notice itself is
   * edition-bound, not settings-bound: no project setting hides it. This is a
   * plain setting, never a runtime licence check. See COMMERCIAL.md.
   */
  bootLogo?: string;
}

/** Props interface shared by every HMI component in the registry */
export interface HmiWidgetProps {
  id?: string;
  properties?: Record<string, unknown>;
  layout?: LayoutConfig;
  children?: ReactNode;
  /** Raw child configs for container-style widgets that need per-child metadata
   *  (e.g. id-keyed positions). Built-in only; not surfaced in the custom-widget SDK. */
  childConfigs?: WidgetConfig[];
}

/** A child-placement entry on an ImageContainer, keyed by child id. */
export interface ChildPosition {
  /** Stable id of the child WidgetConfig this entry positions. */
  id: string;
  /** 0–1 normalized horizontal position relative to the drawn image area. */
  x: number;
  /** 0–1 normalized vertical position relative to the drawn image area. */
  y: number;
  /** Optional manual label; falls back to auto-letter (A, B, C…) by tree order. */
  label?: string;
  /** Optional width override as % of image drawn width (1–100). */
  width?: number;
}
