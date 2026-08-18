import { lazy, Suspense, useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import { useWebSocket } from '@hmi/hooks/useWebSocket';
import { subscribeWidgetUpdated } from '@shared/events/widgetUpdatedBus';
import {
  loadCustomWidgets,
  loadComponents,
  registerComponents,
} from '@hmi/registry/widgetRegistry';
import { useDeviceInfoStore } from '@hmi/store/deviceInfoStore';
import { useVariableStore } from '@hmi/store/variableStore';
import { useThemeRuntimeStore } from '@hmi/store/themeRuntimeStore';
import { useComponentStore } from '@shared/store/componentStore';
import {
  ensureThemeTokens,
  loadAndApplyThemeTokens,
  LS_THEME_SAVED,
} from '@shared/utils/themeTokens';
import { useDocumentChrome } from '@shared/hooks/useDocumentChrome';
import { useDisableBrowserZoom } from '@shared/hooks/useDisableBrowserZoom';
import { registerActionRunner } from '@hmi/utils/actionDispatcher';
import { executeWidgetActions } from '@hmi/utils/widgetActions';
import Spinner, { PageSpinner } from '@shared/components/Spinner';
import BootSplash from '@hmi/components/BootSplash';
import SessionExpiredOverlay from '@shared/components/SessionExpiredOverlay';
import { setSessionExpiredHandler } from '@shared/utils/api';
import { useSessionStore } from '@shared/store/sessionStore';
import { getArea } from '@shared/utils/runtimeBase';

// Wire the dispatcher → widgetActions runner once at module load. This breaks
// the otherwise-cyclic import between the two modules. Only needed for
// HMI/editor content — this module (and everything it pulls in, including the
// widget registry and its recharts loader) is only reached via App.tsx's lazy
// AppInner import, so manager-mode sessions never load any of it.
registerActionRunner(executeWidgetActions);

// Only a project document can lose the manager session out from under a loaded
// app — the manager SPA (which never reaches this module) owns its own login
// screen. Registered at module scope so the fetches below are already covered.
setSessionExpiredHandler(() => useSessionStore.getState().markManagerSessionExpired());

// Ask for the project's themes as this module evaluates — the earliest point
// the app exists at all. The request then flies in parallel with the view
// chunks and the component registry instead of waiting for a view to mount, so
// the boot gate below rarely has anything left to wait on.
void ensureThemeTokens();

/**
 * Gate that delays rendering its children until all custom components are
 * registered. Only used for routes that actually render HMI components
 * (HmiView, PreviewView). Config routes can render immediately.
 *
 * `splash` opts into the full boot screen (branding, version, progress,
 * attribution). Only the operator runtime gets it — the editor's live-preview
 * iframe keeps the bare spinner.
 */
function ComponentsReadyGate({
  children,
  splash = false,
}: {
  children: React.ReactNode;
  splash?: boolean;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // The theme rides along with the component load rather than trailing it, so
    // the first painted frame is already themed instead of flashing the
    // built-in fallback palette. It resolves either way, so a backend that is
    // still coming up delays nothing here.
    Promise.all([loadCustomWidgets(), loadComponents(), ensureThemeTokens()]).then(() =>
      setReady(true),
    );
  }, []);
  if (!ready) {
    return splash ? (
      <BootSplash phase="components" />
    ) : (
      <div className="hmi-boot-loading">
        <Spinner />
      </div>
    );
  }
  return <>{children}</>;
}

// Lazy imports so each view's CSS is only loaded when the route is visited
const HmiView = lazy(() => import('@hmi/pages/HmiView'));
const ConfigRoutes = lazy(() => import('@config/pages/ConfigRoutes'));
// Preview route — loaded inside the editor live-preview iframe
const PreviewView = lazy(() => import('@config/pages/PreviewView'));

export default function AppInner() {
  // Start the WebSocket connection once for the lifetime of the app.
  // Placing it here (inside BrowserRouter) keeps it alive across all routes.
  useWebSocket();
  useDocumentChrome();
  useDisableBrowserZoom();

  // Cache client device info once per session for the $device expression source.
  useEffect(() => {
    useDeviceInfoStore.getState().fetch();
  }, []);

  // On first boot the backend can still be coming up behind the manager proxy
  // when the module-scope load above asks for the themes. The WebSocket opening
  // is the app's own proof that it is serving now, so a load that missed is
  // retried off that signal instead of a timer.
  useEffect(() => {
    return useVariableStore.subscribe((state, prev) => {
      if (state.wsConnected && !prev.wsConnected) void ensureThemeTokens();
    });
  }, []);

  // A theme saved in another tab. Re-fetch, then realign the runtime selection
  // in case the active theme was deleted there (falls back to the default).
  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key !== LS_THEME_SAVED) return;
      void loadAndApplyThemeTokens({ force: true }).then(() => {
        useThemeRuntimeStore.getState().syncActiveTheme();
      });
    }
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  // Reload when the backend recompiles a custom component so the new
  // bundle is picked up everywhere.
  useEffect(() => {
    return subscribeWidgetUpdated(() => {
      window.location.reload();
    });
  }, []);

  // Start loading components eagerly so they're ready as fast as possible.
  // Config routes render immediately; HMI/Preview routes are gated via
  // ComponentsReadyGate so they don't flash "unknown component" states.
  useEffect(() => {
    loadCustomWidgets();
    loadComponents();
    // Keep the component registry in sync when widgets are created/updated/deleted.
    return useComponentStore.subscribe((state, prev) => {
      if (state.loaded && state.components !== prev.components)
        registerComponents(state.components);
    });
  }, []);

  // The /editor/<slug>/ base picks the editor up-front so its root lands on the
  // editor (not the runtime that the bare "/" route renders). Every other base —
  // the /runtime/<slug>/ alias and dev "/" — shares the runtime route map; its
  // extra /config and /preview routes simply never match under a
  // /runtime/<slug>/ URL.
  const routes =
    getArea() === 'editor' ? (
      <Routes>
        <Route
          path="/preview/:pageId"
          element={
            <ComponentsReadyGate>
              <PreviewView />
            </ComponentsReadyGate>
          }
        />
        <Route path="/*" element={<ConfigRoutes />} />
      </Routes>
    ) : (
      <Routes>
        <Route
          path="/"
          element={
            <ComponentsReadyGate splash>
              <HmiView />
            </ComponentsReadyGate>
          }
        />
        <Route
          path="/pages/:id"
          element={
            <ComponentsReadyGate splash>
              <HmiView />
            </ComponentsReadyGate>
          }
        />
        <Route path="/config/*" element={<ConfigRoutes />} />
        <Route
          path="/preview/:pageId"
          element={
            <ComponentsReadyGate>
              <PreviewView />
            </ComponentsReadyGate>
          }
        />
      </Routes>
    );

  return (
    <>
      <Suspense fallback={<PageSpinner variant={getArea() === 'editor' ? 'cfg' : 'hmi'} />}>
        {routes}
      </Suspense>
      <SessionExpiredOverlay />
    </>
  );
}
