import './app-loading.css';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { PageSpinner } from '@shared/components/Spinner';
import { getMode, routerBasename } from '@shared/utils/runtimeBase';
import { preloadableLazy, type PreloadableLazy } from '@shared/utils/settledLazy';

// AppInner (HMI/editor routing, the widget registry, and everything they pull
// in — including the recharts SDK loader) is lazy so a manager-mode session
// never statically reaches it and never pays its bundle cost (backlog item 22).
const AppInner = preloadableLazy(() => import('./AppInner'));
// The manager dashboard is the same SPA bundle served at the origin root
// (window.__NEXTHMI_MODE__ === 'manager'); project instances are proxied under
// /runtime/<slug>/ or /editor/<slug>/ and render the HMI/config app above.
const ManagerApp = preloadableLazy(() => import('./manager/ManagerApp'));

/**
 * Show `fallback` as ordinary content until `View`'s chunk is in, then render
 * it without suspending. A Suspense fallback here would start React's 300 ms
 * reveal throttle (see settledLazy) on every boot; a plain element does not.
 * The Suspense boundaries around it stay for a chunk that fails to load.
 */
function Preloaded({
  view: View,
  fallback,
}: {
  view: PreloadableLazy<object>;
  fallback: ReactNode;
}) {
  const [ready, setReady] = useState(View.isLoaded);
  useEffect(() => {
    if (ready) return;
    const done = () => setReady(true);
    View.preload().then(done, done);
  }, [View, ready]);
  return ready ? <View /> : <>{fallback}</>;
}

export default function App() {
  if (getMode() === 'manager') {
    return (
      <BrowserRouter basename={routerBasename()}>
        <Suspense fallback={<PageSpinner variant="cfg" />}>
          <Preloaded view={ManagerApp} fallback={<PageSpinner variant="cfg" />} />
        </Suspense>
      </BrowserRouter>
    );
  }
  return (
    <BrowserRouter basename={routerBasename()}>
      {/* App palette, like the boundary inside AppInner: what follows this is
          always the boot splash or the editor shell, never HMI content. */}
      <Suspense fallback={<PageSpinner variant="cfg" />}>
        <Preloaded view={AppInner} fallback={<PageSpinner variant="cfg" />} />
      </Suspense>
    </BrowserRouter>
  );
}
