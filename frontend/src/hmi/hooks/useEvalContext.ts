import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useVariableStore } from '../store/variableStore';
import { useTranslationStore } from '@shared/store/translationStore';
import { useHmiStore } from '../store/hmiStore';
import { useUsersData } from './useUsersData';
import { useHmiScope } from '../context/HmiScopeContext';
import { useHostPageId } from '../context/HostPageContext';
import { useInputScope } from '../context/InputScopeContext';
import { useComponentPropStore } from '../store/widgetPropStore';
import { useAlarmStore } from '../store/alarmStore';
import { useRecipeStore } from '../store/recipeStore';
import { useDeviceInfoStore } from '../store/deviceInfoStore';
import { readHttpSource } from '../store/httpSourceStore';
import { useConfigStore } from '@shared/store/configStore';
import { findPagePath, resolvePageContext, resolvePageTitle } from '@shared/utils/pageTree';
import type { PagePathSegment } from '@shared/types/config';
import type { EvaluationContext, ResolvedValue } from '../utils/propertySourceEval';
import { useViewport, getViewportSnapshot } from './useViewport';

const PAGE_ID_PATH_PATTERN = /\/(?:pages|preview)\/([^/]+)/;

/**
 * Returns a fully wired EvaluationContext for use with evaluatePropertyValue /
 * getPropString / getPropNumber / getPropBoolean.
 *
 * @example
 *   const evalCtx = useEvalContext();
 *   const label = getPropString(properties, 'label', 'Default', evalCtx);
 *   const value = getPropNumber(properties, 'value', 0, evalCtx);
 */
export function useEvalContext(): EvaluationContext {
  const activeLanguage = useTranslationStore((s) => s.activeLanguage);
  const translations = useTranslationStore((s) => s.translations);
  const location = useLocation();
  const scope = useHmiScope();
  const hostPageIdFromContext = useHostPageId();
  const inputScopeProps = useInputScope()?.properties;
  const currentUsersByScope = useHmiStore((s) => s.currentUsersByScope);
  // The project's account list, for `$user` with `field: 'userList'` — distinct
  // from `currentUsersByScope`, which is only who is signed in per scope.
  const allUsers = useUsersData();
  const widgetProps = useComponentPropStore((s) => s.props);
  const alarmSummary = useAlarmStore((s) => s.summary);
  const recipeConfig = useRecipeStore((s) => s.config);
  const recipeLoaded = useRecipeStore((s) => s.loaded);
  const deviceInfo = useDeviceInfoStore((s) => s.info);
  // Subscribe so consumers re-render when these change, but read them fresh
  // via getState()/getViewportSnapshot() inside resolvers — keeps the evalCtx
  // reference stable so downstream useMemos don't invalidate on every tick.
  const pages = useConfigStore((s) => s.pages);
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
        resolveVariable: (datasource, path): ResolvedValue => {
          const key = `${datasource}:${path}`;
          // Read fresh via getState() rather than closing over a subscribed
          // snapshot: this keeps the returned evalCtx reference stable across
          // variable ticks. Widgets get their live updates from granular
          // `useLiveScalars` subscriptions instead (see WidgetRenderer), so only
          // widgets that read a changed variable re-render — not every bound one.
          const v = useVariableStore.getState().values[key];
          return (v !== undefined ? v : null) as ResolvedValue;
        },

        resolveTranslation: (key) => useTranslationStore.getState().resolve(key),

        getUrlParam: (name) => new URLSearchParams(location.search).get(name) ?? undefined,

        // Shares `activePageId` so the index route — which renders a page
        // without naming it in the URL — reports that page as active too,
        // rather than `$page` resolving it while `$pageIsActive` reads false.
        isPageActive: (pageId) => activePageId === pageId,

        hostPageId,

        resolveUser: (field) => {
          const user = currentUsersByScope[scope];
          if (!user) return null;
          if (field === 'username') return user.username;
          if (field === 'groups')
            return user.groups.map((id) => user.groupLabels[id] ?? id).join(', ');
          return null;
        },

        resolveUserGroups: () => currentUsersByScope[scope]?.groups ?? ['guest'],

        resolveUserList: () => allUsernames,

        resolveDevice: (field) => {
          if (!deviceInfo) return null;
          return deviceInfo[field] ?? null;
        },

        resolveComponentProp: (componentId, property): ResolvedValue => {
          const val = widgetProps[componentId]?.[property];
          return (val !== undefined ? val : null) as ResolvedValue;
        },

        resolveAlarmCount: (filter) => useAlarmStore.getState().getCount(filter),

        resolveRecipe: (typeId, field) => useRecipeStore.getState().getField(typeId, field),

        resolveRecipeList: (typeId) => useRecipeStore.getState().getList(typeId),

        resolvePagePath: (pageId) => {
          const target = pageId ?? activePageId;
          if (!target) return [];
          const trail = findPagePath(useConfigStore.getState().pages, target);
          return trail.map((n) => ({
            id: n.id,
            label: pageBreadcrumbLabel(n) ?? resolvePageTitle(n.title),
          }));
        },

        resolvePage: (field, pageId, separator): ResolvedValue => {
          const target = pageId ?? activePageId;
          if (!target) return null;
          const trail = findPagePath(useConfigStore.getState().pages, target);
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
            default:
              return null;
          }
        },

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

        inputScopeProps,
      };
    },
    // activeLanguage/translations/alarmSummary/recipe* force memo invalidation
    // even though their resolvers call getState() — without them, consumers
    // would not re-evaluate on language/alarm/recipe changes. The store's
    // `values` map is deliberately absent: variable ticks must NOT churn this
    // context (that was the per-tick re-render storm); reactivity to `$var`
    // comes from granular `useLiveScalars` subscriptions at the widget boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      activeLanguage,
      translations,
      location,
      scope,
      inputScopeProps,
      currentUsersByScope,
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

function pageBreadcrumbLabel(node: object): string | null {
  const v = (node as Record<string, unknown>).breadcrumbLabel;
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
