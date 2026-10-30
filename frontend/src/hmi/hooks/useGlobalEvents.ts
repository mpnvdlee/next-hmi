import { useEffect, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useConfigStore } from '@shared/store/configStore';
import { useHmiStore } from '../store/hmiStore';
import { useVariableStore } from '../store/variableStore';
import { NO_DATA_GRACE_MS } from '../components/DataSettleGate';
import { useTranslationStore } from '@shared/store/translationStore';
import { executeWidgetActions } from '../utils/widgetActions';
import { resolvePageContext } from '@shared/utils/pageTree';
import { evaluatePropertyValue } from '../utils/propertySourceEval';
import type { EvaluationContext, ResolvedValue } from '../utils/propertySourceEval';
import type { GlobalEventsConfig } from '@shared/types/config';

/**
 * Fires global lifecycle events configured in the "Global Events" node.
 *
 * Must be called once inside HmiView, after the scope context is established.
 *
 * Events:
 * - onHmiLoaded:     fires once when the HMI view first mounts, once the first
 *                    context's values have arrived (or after a grace)
 * - onPageLoaded:    fires on every page navigation
 * - onLocaleChanged: fires when the active language changes (skips initial)
 * - onUserLoggedIn:  fires when a user identity appears for this scope
 * - onUserLoggedOut: fires when a user identity is removed for this scope
 * - onVariableChanged: each trigger fires when its variable's value changes
 */
export function useGlobalEvents(scope: string): void {
  const { id: routeId } = useParams<{ id: string }>();
  const pages = useConfigStore((s) => s.pages);
  // Resolve to the actual rendered page id, not the raw route param: a route
  // that names a page-group falls back to its first child (PageGroupPageView's
  // `fellBackToFirstChild` replace-navigate), which would otherwise look like
  // a second, distinct navigation and double-fire onPageLoaded below.
  const pageId = useMemo(() => resolvePageContext(pages, routeId).page?.id, [pages, routeId]);
  const globalEventsRef = useRef<GlobalEventsConfig>({});

  // Keep a live ref to the latest globalEvents so effect callbacks never
  // read stale closures.
  useEffect(() => {
    globalEventsRef.current = useConfigStore.getState().globalEvents;
    return useConfigStore.subscribe((state) => {
      globalEventsRef.current = state.globalEvents;
    });
  }, []);

  // ── onHmiLoaded + initial onPageLoaded ──────────────────────────────────
  // Both fire once, after the config is hydrated from the API (configStore.loaded)
  // and the first `context_ready` says the values HmiView asked for — the
  // page's and onHmiLoaded's own — are in the store, so an `if` on a tag reads
  // its value rather than "no value yet". A context_ready that never comes
  // (backend down, no page) is waited out for the same grace the binding marks
  // get. Store subscriptions rather than one timer handle React StrictMode's
  // double-mount (refs survive cleanup, subscriptions are re-established).
  const initialFiredRef = useRef(false);
  useEffect(() => {
    let grace: ReturnType<typeof setTimeout> | undefined;
    function fireInitial() {
      if (initialFiredRef.current) return;
      initialFiredRef.current = true;
      const ge = useConfigStore.getState().globalEvents;
      executeWidgetActions(ge.onHmiLoaded, { scope });
      executeWidgetActions(ge.onPageLoaded, { scope });
    }
    function tryFireInitial() {
      if (initialFiredRef.current || !useConfigStore.getState().loaded) return;
      if (useVariableStore.getState().contextReadyPageIds.length > 0) fireInitial();
      else grace ??= setTimeout(fireInitial, NO_DATA_GRACE_MS);
    }
    tryFireInitial();
    const unsubscribe = [
      useConfigStore.subscribe(tryFireInitial),
      useVariableStore.subscribe(tryFireInitial),
    ];
    return () => {
      unsubscribe.forEach((u) => u());
      clearTimeout(grace);
    };
  }, [scope]);

  // ── onPageLoaded for subsequent navigations ──────────────────────────────
  const prevPageIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!pageId) return;
    // Skip the first page — handled by the initial effect above
    if (prevPageIdRef.current === undefined) {
      prevPageIdRef.current = pageId;
      return;
    }
    if (prevPageIdRef.current === pageId) return;
    prevPageIdRef.current = pageId;
    executeWidgetActions(globalEventsRef.current.onPageLoaded, { scope });
  }, [pageId, scope]);

  // ── onLocaleChanged ──────────────────────────────────────────────────────
  const prevLanguageRef = useRef<string | null>(null);
  useEffect(() => {
    prevLanguageRef.current = useTranslationStore.getState().activeLanguage;
    return useTranslationStore.subscribe((state) => {
      const lang = state.activeLanguage;
      if (prevLanguageRef.current === null) {
        prevLanguageRef.current = lang;
        return;
      }
      if (lang !== prevLanguageRef.current) {
        prevLanguageRef.current = lang;
        executeWidgetActions(globalEventsRef.current.onLocaleChanged, { scope });
      }
    });
  }, [scope]);

  // ── onVariableChanged ────────────────────────────────────────────────────
  // The first value counts as a change, so a trigger also fires at start-up
  // with the state the variable is already in. Only defined values are
  // remembered: a reconnect that drops and restores the same value is no change.
  // Keyed by the binding, not the trigger object, so an edit to a trigger's
  // actions in the live preview does not count as a change of its variable.
  useEffect(() => {
    const last = new Map<string, unknown>();
    const evalCtx: EvaluationContext = {
      resolveVariable: (ds, path) =>
        (useVariableStore.getState().values[`${ds}:${path}`] ?? null) as ResolvedValue,
    };
    function check() {
      const changed = new Map<string, boolean>();
      for (const trigger of globalEventsRef.current.onVariableChanged ?? []) {
        if (!trigger.variable) continue;
        const key = JSON.stringify(trigger.variable);
        if (!changed.has(key)) {
          const value = evaluatePropertyValue(trigger.variable, evalCtx);
          const isChange = value !== null && !Object.is(value, last.get(key));
          if (isChange) last.set(key, value);
          changed.set(key, isChange);
        }
        if (changed.get(key)) executeWidgetActions(trigger.actions, { scope });
      }
    }
    check();
    const unsubscribe = [useVariableStore.subscribe(check), useConfigStore.subscribe(check)];
    return () => unsubscribe.forEach((u) => u());
  }, [scope]);

  // ── onUserLoggedIn / onUserLoggedOut ─────────────────────────────────────
  // The backend always has a user in scope (at minimum "guest"), so we detect
  // login/logout by watching whether the username is the unauthenticated guest.
  const prevUsernameRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const initial = useHmiStore.getState().currentUsersByScope[scope];
    prevUsernameRef.current = initial?.username ?? 'guest';
    return useHmiStore.subscribe((state) => {
      const user = state.currentUsersByScope[scope];
      const username = user?.username ?? 'guest';
      const prev = prevUsernameRef.current;
      if (prev === username) return;
      prevUsernameRef.current = username;
      const wasGuest = !prev || prev === 'guest';
      const isGuest = username === 'guest';
      if (wasGuest && !isGuest) {
        executeWidgetActions(globalEventsRef.current.onUserLoggedIn, { scope });
      } else if (!wasGuest && isGuest) {
        executeWidgetActions(globalEventsRef.current.onUserLoggedOut, { scope });
      }
    });
  }, [scope]);
}
