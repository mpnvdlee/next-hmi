import { useEffect, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useConfigStore } from '@shared/store/configStore';
import { useHmiStore } from '../store/hmiStore';
import { useTranslationStore } from '@shared/store/translationStore';
import { executeWidgetActions } from '../utils/widgetActions';
import { resolvePageContext } from '@shared/utils/pageTree';
import type { GlobalEventsConfig } from '@shared/types/config';

/**
 * Fires global lifecycle events configured in the "Global Events" node.
 *
 * Must be called once inside HmiView, after the scope context is established.
 *
 * Events:
 * - onHmiLoaded:     fires once when the HMI view first mounts
 * - onPageLoaded:    fires on every page navigation
 * - onLocaleChanged: fires when the active language changes (skips initial)
 * - onUserLoggedIn:  fires when a user identity appears for this scope
 * - onUserLoggedOut: fires when a user identity is removed for this scope
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
  // Both fire once when the config is hydrated from the API (configStore.loaded).
  // Subscribing to the loaded flag — instead of using setTimeout — ensures we
  // never fire before globalEvents is available, and handles React StrictMode's
  // double-mount correctly (refs survive cleanup, subscription is re-established).
  const initialFiredRef = useRef(false);
  useEffect(() => {
    function tryFireInitial() {
      if (initialFiredRef.current) return;
      initialFiredRef.current = true;
      const ge = useConfigStore.getState().globalEvents;
      executeWidgetActions(ge.onHmiLoaded, { scope });
      executeWidgetActions(ge.onPageLoaded, { scope });
    }
    if (useConfigStore.getState().loaded) {
      tryFireInitial();
      return;
    }
    return useConfigStore.subscribe((s) => {
      if (s.loaded) tryFireInitial();
    });
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
