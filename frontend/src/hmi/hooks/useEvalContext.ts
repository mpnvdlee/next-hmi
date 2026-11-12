import { createContext, useContext, useMemo, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useVariableStore } from '../store/variableStore';
import { buildVarKey } from '@shared/types/datasource';
import { useTranslationStore } from '@shared/store/translationStore';
import { resolveUserField, useHmiStore, type UserAccount } from '../store/hmiStore';
import { useUsersData } from './useUsersData';
import { useHmiScope } from '../context/HmiScopeContext';
import { useHostPageId } from '../context/HostPageContext';
import { useInputScope } from '../context/InputScopeContext';
import { useRepeatScope } from '../context/RepeatScopeContext';
import { readArrayElement, resolveRepeatItem } from '../utils/repeatItemResolution';
import { scopedWidgetId } from './usePublishWidgetProp';
import { useComponentPropStore } from '../store/widgetPropStore';
import { useAlarmStore } from '../store/alarmStore';
import { useRecipeStore } from '../store/recipeStore';
import { useDeviceInfoStore } from '../store/deviceInfoStore';
import { readHttpSource } from '../store/httpSourceStore';
import { findValueMap, useConfigStore } from '@shared/store/configStore';
import { withDeclaredDefaults } from '../utils/componentPropResolution';
import {
  allPageRootNodes,
  findPageNodeById,
  findPagePath,
  isPageGroup,
  resolvePageContext,
  resolvePageTitle,
} from '@shared/utils/pageTree';
import type { PageGroupChild, PagePathSegment } from '@shared/types/config';
import { PageGroupStackContext, pickPageGroup } from '../components/PageGroupStackContext';
import type { EvaluationContext, ResolvedValue } from '../utils/propertySourceEval';
import { analyzePropertyValue } from '../utils/analyzePropertyValue';
import { useViewport, getViewportSnapshot } from './useViewport';

/** Stable, so an `accounts` list memo holds for a non-admin. */
const NO_ACCOUNTS: UserAccount[] = [];

const PAGE_ID_PATH_PATTERN = /\/(?:pages|preview)\/([^/]+)/;

// Stores an eval context follows only for a reader whose sources read them:
// every reader following them made one alarm update, published export or
// opened dialog re-render every widget on the page.
const WIDGET_PROPS = 1;
const ALARMS = 2;
const RECIPES = 4;
const OVERLAYS = 8;
const DEVICE = 16;
export const ALL_STORES = WIDGET_PROPS | ALARMS | RECIPES | OVERLAYS | DEVICE;

const STORES_OF_SOURCE: Record<string, number> = {
  $widgetProp: WIDGET_PROPS,
  $alarmCount: ALARMS,
  $recipe: RECIPES,
  $recipeList: RECIPES,
  $device: DEVICE,
  // Both evaluate a value kept elsewhere, which may hold any source: a dialog
  // input as the opener passed it, a value map's cases.
  $overlay: ALL_STORES,
  $map: ALL_STORES,
};

/** The stores the sources anywhere in `values` read, for `useEvalContext`. */
export function storesReadBy(...values: unknown[]): number {
  let stores = 0;
  for (const value of values) {
    for (const key of analyzePropertyValue(value).sourceKeys) stores |= STORES_OF_SOURCE[key] ?? 0;
  }
  return stores;
}

/** The stores the widget around a reader evaluates (see WidgetRenderer); all of
 *  them outside any widget, where nothing says what will be evaluated. */
export const WidgetStoresContext = createContext(ALL_STORES);

/** `$page` groupIndex / groupLastIndex of the child `childId` among a group's children. */
function tabField(field: 'groupIndex' | 'groupLastIndex', tabs: PageGroupChild[], childId: string) {
  return field === 'groupLastIndex' ? tabs.length - 1 : tabs.findIndex((c) => c.id === childId);
}

/** A `$var` read fresh from the store; null until it has a value. Read through
 *  getState() rather than a subscribed snapshot, so an eval context holding it
 *  stays the same object across variable ticks: widgets get their live updates
 *  from granular `useLiveScalars` subscriptions instead (see WidgetRenderer),
 *  so only widgets that read a changed variable re-render. */
export function readStoredVariable(datasource: string, path: string): ResolvedValue {
  const value = useVariableStore.getState().values[buildVarKey(datasource, path)];
  return (value !== undefined ? value : null) as ResolvedValue;
}

/** A `$var` read at `index`, fresh from the store: the element (a member of
 *  one included, `readArrayElement`), else a non-array value as itself. */
export function readStoredElement(datasource: string, path: string, index: number): ResolvedValue {
  const key = buildVarKey(datasource, path);
  const { values, varMeta } = useVariableStore.getState();
  const element = readArrayElement(values, varMeta, key, index);
  if (element !== undefined) return element as ResolvedValue;
  // A non-array value with an index reads as itself, as it always did.
  const whole = values[key];
  return (whole === undefined || Array.isArray(whole) ? null : whole) as ResolvedValue;
}

/** The `$var` readers of every eval context that reads the live store. */
export const STORE_VARIABLE_RESOLVERS: Pick<
  EvaluationContext,
  'resolveVariable' | 'resolveElement'
> = {
  resolveVariable: readStoredVariable,
  resolveElement: readStoredElement,
};

/**
 * Returns a fully wired EvaluationContext for use with evaluatePropertyValue /
 * getPropString / getPropNumber / getPropBoolean.
 *
 * Every resolver reads its store fresh. The context changes, and so re-renders
 * its reader, on a change to a store in `stores` (`storesReadBy` of what the
 * reader evaluates), by default the ones the surrounding widget's properties
 * read.
 *
 * @example
 *   const evalCtx = useEvalContext();
 *   const label = getPropString(properties, 'label', 'Default', evalCtx);
 *   const value = getPropNumber(properties, 'value', 0, evalCtx);
 */
export function useEvalContext(stores?: number): EvaluationContext {
  const widgetStores = useContext(WidgetStoresContext);
  const follows = stores ?? widgetStores;
  const activeLanguage = useTranslationStore((s) => s.activeLanguage);
  const translations = useTranslationStore((s) => s.translations);
  const location = useLocation();
  const scope = useHmiScope();
  const hostPageIdFromContext = useHostPageId();
  const groupStack = useContext(PageGroupStackContext);
  const inputScopeProps = useInputScope()?.properties;
  const repeatScope = useRepeatScope();
  const currentUsersByScope = useHmiStore((s) => s.currentUsersByScope);
  // Subscribed so a `$overlay` re-reads when a dialog opens, swaps or closes.
  const openPageOverlays = useHmiStore((s) => (follows & OVERLAYS ? s.openPageOverlays : null));
  // The project's account list, for `$user` with `field: 'userList'` — distinct
  // from `currentUsersByScope`, which is only who is signed in per scope.
  const allUsers = useUsersData();
  const widgetProps = useComponentPropStore((s) => (follows & WIDGET_PROPS ? s.props : null));
  const alarmSummary = useAlarmStore((s) => (follows & ALARMS ? s.summary : null));
  const recipeConfig = useRecipeStore((s) => (follows & RECIPES ? s.config : null));
  const recipeLoaded = useRecipeStore((s) => (follows & RECIPES ? s.loaded : null));
  const deviceInfo = useDeviceInfoStore((s) => (follows & DEVICE ? s.info : null));
  // Subscribe so consumers re-render when these change, but read them fresh
  // via getState()/getViewportSnapshot() inside resolvers — keeps the evalCtx
  // reference stable so downstream useMemos don't invalidate on every tick.
  const pages = useConfigStore((s) => s.pages);
  // Subscribed so a title or breadcrumb edit in the Dialogs folder reaches the
  // widgets bound to `$page`, and held in a ref so the resolvers below read the
  // current roots without the memo having to churn on every page edit — the
  // same split the other resolvers make with `getState()`.
  const dialogs = useConfigStore((s) => s.dialogs);
  // Subscribed so an edited map re-evaluates its `$map`s; read fresh below.
  const valueMaps = useConfigStore((s) => s.valueMaps);
  const pageRootsRef = useRef({ pages, dialogs });
  pageRootsRef.current = { pages, dialogs };
  useViewport();

  const activePageId = useMemo(() => {
    const match = location.pathname.match(PAGE_ID_PATH_PATTERN);
    if (match) return match[1];
    // The index route renders a page without naming it in the URL — HmiView
    // falls back to the first page, so resolve the same one here. Without this
    // every `$page` on the landing page evaluates against no page at all and
    // silently returns null (an empty page title in the header).
    return resolvePageContext(pages, undefined).page?.id;
  }, [location.pathname, pages]);

  const hostPageId = hostPageIdFromContext ?? activePageId;

  const allUsernames = useMemo(() => allUsers.map((u) => u.username), [allUsers]);

  return useMemo(
    () => {
      return {
        ...STORE_VARIABLE_RESOLVERS,

        resolveTranslation: (key) => useTranslationStore.getState().resolve(key),

        resolveValueMap: findValueMap,

        getUrlParam: (name) => new URLSearchParams(location.search).get(name) ?? undefined,

        // Shares `activePageId` so the index route — which renders a page
        // without naming it in the URL — reports that page as active too,
        // rather than `$page` resolving it while `$pageIsActive` reads false.
        isPageActive: (pageId) => activePageId === pageId,

        hostPageId,

        resolveUser: (field) => resolveUserField(currentUsersByScope[scope], field),

        resolveUserGroups: () => currentUsersByScope[scope]?.groups ?? ['guest'],

        resolveUserList: () => allUsernames,

        resolveUserAccounts: () => currentUsersByScope[scope]?.accounts ?? NO_ACCOUNTS,

        resolveDevice: (field) => useDeviceInfoStore.getState().info?.[field] ?? null,

        resolveComponentProp: (componentId, property): ResolvedValue => {
          // Fresh, like resolveVariable: an action run in the handler that just
          // published a value must read it, not this render's snapshot.
          const props = useComponentPropStore.getState().props;
          const val = exportsFor(props, componentId, repeatScope?.key)?.[property];
          return (val !== undefined ? val : null) as ResolvedValue;
        },

        resolveAlarmCount: (filter) => useAlarmStore.getState().getCount(filter),

        resolveRecipe: (typeId, field, parameter) =>
          useRecipeStore.getState().getField(typeId, field, parameter),

        resolveRecipeList: (typeId) => useRecipeStore.getState().getList(typeId),

        resolvePagePath: (pageId) => {
          const target = pageId ?? hostPageId;
          if (!target) return [];
          // Both roots: an overlay of the Dialogs folder publishes its own page
          // as the host, and that page is not in the navigable tree.
          const trail = findPagePath(allPageRootNodes(pageRootsRef.current), target);
          return trail.map((n) => ({
            id: n.id,
            label: pageBreadcrumbLabel(n) ?? resolvePageTitle(n.title),
          }));
        },

        // Defaults to the page being rendered, not the route's: a page overlay
        // renders a page without touching the URL, so keying on the route would
        // report the host page behind the overlay throughout it.
        resolvePage: (field, pageId, separator): ResolvedValue => {
          if ((field === 'groupIndex' || field === 'groupLastIndex') && !pageId) {
            // The group the tab actions switch, so a widget in a group's own
            // header or footer reads that group's tab, not a nested one's.
            const entry = pickPageGroup(groupStack);
            if (entry) return tabField(field, entry.group.children, entry.activePage.id);
          }
          const target = pageId ?? hostPageId;
          if (!target) return null;
          const trail = findPagePath(allPageRootNodes(pageRootsRef.current), target);
          if (trail.length === 0) return null;
          const node = trail[trail.length - 1];
          const meta = node as unknown as Record<string, unknown>;
          switch (field) {
            case 'id':
              return node.id;
            case 'title':
              return resolvePageTitle(node.title);
            case 'icon':
              return typeof meta.icon === 'string' ? meta.icon : null;
            case 'description':
              return typeof meta.description === 'string' ? (meta.description as string) : null;
            case 'breadcrumbLabel':
              return pageBreadcrumbLabel(node) ?? resolvePageTitle(node.title);
            case 'depth':
              return trail.length - 1;
            case 'parentId':
              return trail.length >= 2 ? trail[trail.length - 2].id : null;
            case 'pathString': {
              const sep = separator ?? ' / ';
              return trail
                .map((n) => pageBreadcrumbLabel(n) ?? resolvePageTitle(n.title))
                .join(sep);
            }
            case 'pathSegments': {
              const segments: PagePathSegment[] = trail.map((n) => ({
                id: n.id,
                label: pageBreadcrumbLabel(n) ?? resolvePageTitle(n.title),
              }));
              return JSON.stringify(segments);
            }
            case 'groupIndex':
            case 'groupLastIndex': {
              const parent = trail[trail.length - 2];
              return parent && isPageGroup(parent)
                ? tabField(field, parent.children, node.id)
                : null;
            }
            default:
              return null;
          }
        },

        resolvePageGroup: (groupId) => pickPageGroup(groupStack, groupId),

        resolveViewport: (field): ResolvedValue => {
          const v = getViewportSnapshot();
          switch (field) {
            case 'size':
              return v.size;
            case 'width':
              return v.width;
            case 'height':
              return v.height;
            case 'orientation':
              return v.orientation;
            default:
              return null;
          }
        },

        // Reads the cache and primes the fetch; reactivity comes from the
        // `useHttpTick` subscription at the widget boundary, same split as
        // `$var`/`useLiveScalars`.
        resolveHttpRequest: (spec) => readHttpSource(spec),

        resolveOverlayParam: (page, param) => {
          const entry = [...useHmiStore.getState().openPageOverlays]
            .reverse()
            .find((e) => e.pageId === page);
          if (!entry) return null;
          const declared = findPageNodeById(
            pageRootsRef.current.dialogs,
            page,
          )?.componentProperties;
          return withDeclaredDefaults(entry.componentProperties, declared)[param] ?? null;
        },

        inputScopeProps,

        ...(repeatScope && {
          repeatIndex: repeatScope.index,
          resolveRepeatItem: (payload: unknown) =>
            resolveRepeatItem(payload, repeatScope, useVariableStore.getState().varMeta),
        }),
      };
    },
    // activeLanguage/translations/alarmSummary/recipe*/widgetProps/deviceInfo/
    // openPageOverlays force memo invalidation even though their resolvers call
    // getState() — without them, consumers would not re-evaluate on a change to
    // a store they follow. The store's
    // `values` map is deliberately absent: variable ticks must NOT churn this
    // context (that was the per-tick re-render storm); reactivity to `$var`
    // comes from granular `useLiveScalars` subscriptions at the widget boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      activeLanguage,
      translations,
      valueMaps,
      location,
      scope,
      inputScopeProps,
      repeatScope,
      groupStack,
      currentUsersByScope,
      openPageOverlays,
      allUsernames,
      widgetProps,
      alarmSummary,
      recipeConfig,
      recipeLoaded,
      deviceInfo,
      activePageId,
      hostPageId,
    ],
  );
}

/**
 * A widget's exports as seen from inside a Repeater copy: the same copy's first,
 * then each enclosing copy's (a sibling of an inner Repeater lives in the outer
 * copy), and only then the bare id a widget outside every Repeater publishes.
 * Keyed on whether the widget published at all, so a copy whose sibling has not
 * published yet reads nothing rather than another copy's value.
 */
function exportsFor(
  widgetProps: Record<string, Record<string, unknown>>,
  componentId: string,
  repeatKey: string | undefined,
): Record<string, unknown> | undefined {
  let key = repeatKey;
  while (key) {
    const scoped = widgetProps[scopedWidgetId(componentId, key)];
    if (scoped) return scoped;
    const slash = key.lastIndexOf('/');
    key = slash >= 0 ? key.slice(0, slash) : undefined;
  }
  return widgetProps[componentId];
}

function pageBreadcrumbLabel(node: object): string | null {
  const v = (node as Record<string, unknown>).breadcrumbLabel;
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
